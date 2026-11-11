// 预检（`pnpm bench doctor`）：在花掉几小时机时和几百块模型费之前，
// 先回答「这台机器现在到底能不能跑这一批」。
//
// 起因很具体：官方 harness 缺 docker、缺 swebench、或 HF 镜像连不上时，
// 报错发生在 agent 已经把 300 题都跑完之后——钱花了，拿回来的是一堆 KeyError。
// 所以每条检查都要快（子进程 5s、网络 5s）并且给修复命令，整体十几秒内出结论。
//
// 检查分两类：
// - fail：继续跑一定拿不到可信结果（缺 key、缺 docker、题目文件不存在、磁盘不够）
// - warn：能跑但结论要打折扣（工作区是脏的、遥测关闭、docker 在但没有镜像缓存）
//
// 所有外部探针（子进程、fetch、git 事实）都从 deps 注入：默认是真身，
// 测试传假实现，从而保持「测试不触网、不 exec 外部工具」这条纪律。

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelTier, Settings } from "@hotpot/core";
import { collectAgentFacts } from "./manifest.ts";
import { runCommand } from "./process.ts";
import { DEFAULT_HF_ENDPOINT } from "./swebench/evaluate.ts";
import { loadInstances } from "./swebench/instances.ts";

const PROBE_TIMEOUT_MS = 5000;
// 300 题 × 每题 worktree + 仓库缓存，5 GB 是硬底线，20 GB 以下只提醒
const DISK_FAIL_BYTES = 5 * 1024 ** 3;
const DISK_WARN_BYTES = 20 * 1024 ** 3;

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: CheckStatus;
	detail: string;
	// 修复建议：fail 时必须给出可执行的下一步
	fix?: string;
}

export interface DoctorReport {
	checks: DoctorCheck[];
	failed: number;
	warned: number;
}

export interface DoctorOptions {
	cwd: string;
	settings: Settings;
	modelTier: ModelTier;
	instancesFile: string;
	evalMode: "local" | "remote";
	evalHost: string;
	outputDir: string;
	// --offline：跳过一切网络探测（离线机器/CI 里只想查本地条件）
	checkNetwork?: boolean;
}

export interface DoctorDeps {
	runCommand: typeof runCommand;
	fetchImpl: typeof fetch;
	collectFacts: typeof collectAgentFacts;
}

const DEFAULT_DEPS: DoctorDeps = {
	runCommand,
	fetchImpl: fetch,
	collectFacts: collectAgentFacts,
};

export async function runDoctor(
	opts: DoctorOptions,
	deps: Partial<DoctorDeps> = {},
): Promise<DoctorReport> {
	const probe: DoctorDeps = { ...DEFAULT_DEPS, ...deps };
	const checks: DoctorCheck[] = [];
	const push = (check: DoctorCheck): void => {
		checks.push(check);
	};

	push(checkModelTier(opts.settings, opts.modelTier));
	push(checkNode());
	push(await checkGit(opts.cwd, probe));
	push(await checkInstances(opts.instancesFile));
	push(await checkOutputDir(opts.outputDir));
	push(await checkDisk(opts.outputDir, probe));

	if (opts.evalMode === "local") {
		push(await checkPython(probe));
		push(await checkDocker(probe));
		if (opts.checkNetwork !== false) {
			push(await checkHuggingFace(probe));
		}
	} else {
		push(await checkSsh(opts.evalHost, probe));
		push(await checkTmux(opts.evalHost, probe));
	}

	push(await checkTelemetry(opts.settings, opts.checkNetwork !== false, probe));

	return {
		checks,
		failed: checks.filter((check) => check.status === "fail").length,
		warned: checks.filter((check) => check.status === "warn").length,
	};
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines = report.checks.map((check) => {
		const head = `[${check.status}] ${check.name}: ${check.detail}`;
		return check.fix === undefined
			? head
			: `${head}\n        fix: ${check.fix}`;
	});
	const verdict =
		report.failed > 0
			? `doctor: ${report.failed} 项必须修复后才能跑（${report.warned} 项提醒）`
			: `doctor: ok（${report.warned} 项提醒）`;
	lines.push("", verdict);
	return lines.join("\n");
}

function checkModelTier(settings: Settings, tier: ModelTier): DoctorCheck {
	const ref = settings.models[tier];
	const missing = (["provider", "model", "apiKey"] as const).filter(
		(key) => ref[key] === undefined || ref[key].trim() === "",
	);
	if (missing.length > 0) {
		return {
			name: `model tier ${tier}`,
			status: "fail",
			detail: `缺少 ${missing.join(", ")}`,
			fix: "在 ~/.hotpot/settings.json 补齐该档位的 provider/model/apiKey",
		};
	}
	const unresolved = envRef(ref.apiKey);
	if (unresolved !== undefined) {
		return {
			name: `model tier ${tier}`,
			status: "fail",
			detail: `apiKey 指向未设置的环境变量 ${unresolved}`,
			fix: `export ${unresolved}=... 后再跑批（或把 apiKey 写成字面值）`,
		};
	}
	const extra = (["high", "medium", "low"] as const).filter(
		(other) => other !== tier && !hasUsableKey(settings.models[other].apiKey),
	);
	return {
		name: `model tier ${tier}`,
		status: extra.length === 0 ? "ok" : "warn",
		detail:
			extra.length === 0
				? `${ref.provider}/${ref.model}`
				: `${ref.provider}/${ref.model}；${extra.join("/")} 档不可用（worker/task 可能用到）`,
	};
}

function hasUsableKey(apiKey: string): boolean {
	return apiKey.trim() !== "" && envRef(apiKey) === undefined;
}

// "$NAME" 形式表示「从环境变量取」；返回变量名便于报错，非该形式返回 undefined
function envRef(value: string): string | undefined {
	if (!value.startsWith("$")) {
		return undefined;
	}
	const name = value.slice(1);
	if (name === "" || process.env[name] === undefined) {
		return name === "" ? "(空变量名)" : name;
	}
	return undefined;
}

function checkNode(): DoctorCheck {
	const major = Number(process.version.replace(/^v/, "").split(".")[0] ?? "0");
	return {
		name: "node",
		status: major >= 20 ? "ok" : "warn",
		detail: `${process.version}（官方 harness 与 sweep 工具链按 Node 20+ 验证）`,
	};
}

async function checkGit(cwd: string, probe: DoctorDeps): Promise<DoctorCheck> {
	const facts = await probe.collectFacts(cwd);
	if (facts.git.commit === null) {
		return {
			name: "git",
			status: "warn",
			detail:
				"取不到 commit（不在 git 仓库或没装 git），本轮结论无法对应到具体提交",
			fix: "在 agent 仓库根目录下跑批，或接受 manifest 里 commit 为 null",
		};
	}
	if (facts.git.dirty === true) {
		return {
			name: "git",
			status: "warn",
			detail: `${facts.git.commit.slice(0, 7)} + 未提交改动（报告里的 commit 不代表实际跑的代码）`,
			fix: "先 git stash / commit，让报告能对应到确定的代码版本",
		};
	}
	return {
		name: "git",
		status: "ok",
		detail: `${facts.git.commit.slice(0, 7)} (clean)`,
	};
}

async function checkInstances(file: string): Promise<DoctorCheck> {
	try {
		const instances = await loadInstances(file);
		const ids = new Set(instances.map((instance) => instance.instance_id));
		if (ids.size !== instances.length) {
			return {
				name: "instances",
				status: "warn",
				detail: `${instances.length} 行里有重复 id（同一题会被跑两次）`,
			};
		}
		return {
			name: "instances",
			status: "ok",
			detail: `${instances.length} 题（${file}）`,
		};
	} catch (err) {
		return {
			name: "instances",
			status: "fail",
			detail: err instanceof Error ? err.message : String(err),
			fix: "python benchmarks/scripts/export_instances.py 重新导出，或检查 --instances-file 路径",
		};
	}
}

async function checkOutputDir(dir: string): Promise<DoctorCheck> {
	const probeFile = join(dir, ".doctor-probe");
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(probeFile, "ok");
		await rm(probeFile, { force: true });
		return { name: "output dir", status: "ok", detail: `${dir} 可写` };
	} catch (err) {
		return {
			name: "output dir",
			status: "fail",
			detail: `不可写：${err instanceof Error ? err.message : String(err)}`,
			fix: "换一个 --output 目录，或修正权限",
		};
	}
}

async function checkDisk(dir: string, probe: DoctorDeps): Promise<DoctorCheck> {
	const result = await probe.runCommand("df", ["-k", dir], {
		cwd: dir,
		timeoutMs: PROBE_TIMEOUT_MS,
	});
	if (result.code !== 0) {
		return {
			name: "disk",
			status: "warn",
			detail: `df 执行失败，无法判断剩余空间：${result.stderr.trim() || "unknown"}`,
		};
	}
	const parts = result.stdout.trim().split("\n")[1]?.split(/\s+/) ?? [];
	const availableKb = Number(parts[3] ?? "");
	if (!Number.isFinite(availableKb)) {
		return { name: "disk", status: "warn", detail: "无法解析 df 输出" };
	}
	const available = availableKb * 1024;
	const human = `${(available / 1024 ** 3).toFixed(1)} GB 可用`;
	if (available < DISK_FAIL_BYTES) {
		return {
			name: "disk",
			status: "fail",
			detail: `仅 ${human}，300 题跑批会写爆磁盘`,
			fix: "清理 benchmark-runs/ 与 issue 仓库缓存，或把 --output 指到大盘",
		};
	}
	return {
		name: "disk",
		status: available < DISK_WARN_BYTES ? "warn" : "ok",
		detail: human,
	};
}

async function checkPython(probe: DoctorDeps): Promise<DoctorCheck> {
	const result = await probe.runCommand(
		"python3",
		["-c", "import swebench; print('swebench ok')"],
		{ cwd: process.cwd(), timeoutMs: PROBE_TIMEOUT_MS },
	);
	if (result.code !== 0) {
		return {
			name: "swebench harness",
			status: "fail",
			detail: `python3 -m swebench 不可用：${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`,
			fix: "在评测环境里 pip install swebench（或激活已有 venv 后重跑 doctor）",
		};
	}
	return {
		name: "swebench harness",
		status: "ok",
		detail: "python3 -m swebench 可用",
	};
}

async function checkDocker(probe: DoctorDeps): Promise<DoctorCheck> {
	const result = await probe.runCommand(
		"docker",
		["info", "--format", "{{.ServerVersion}}"],
		{ cwd: process.cwd(), timeoutMs: PROBE_TIMEOUT_MS },
	);
	if (result.code !== 0) {
		return {
			name: "docker",
			status: "fail",
			detail: `docker daemon 不可用：${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`,
			fix: "启动 Docker Desktop（或 systemctl start docker）后重跑；官方 harness 需要它构建评测容器",
		};
	}
	return {
		name: "docker",
		status: "ok",
		detail: `daemon ${result.stdout.trim() || "ok"}`,
	};
}

async function checkHuggingFace(probe: DoctorDeps): Promise<DoctorCheck> {
	const endpoint = process.env.HF_ENDPOINT ?? DEFAULT_HF_ENDPOINT;
	try {
		const response = await probe.fetchImpl(endpoint, {
			method: "HEAD",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		await response.body?.cancel().catch(() => {});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return { name: "hf endpoint", status: "ok", detail: endpoint };
	} catch (err) {
		return {
			name: "hf endpoint",
			status: "warn",
			detail: `${endpoint} 不可达：${err instanceof Error ? err.message : String(err)}`,
			fix: "export HF_ENDPOINT=<可用镜像>；数据集已缓存时评测仍可离线进行",
		};
	}
}

async function checkSsh(host: string, probe: DoctorDeps): Promise<DoctorCheck> {
	const result = await probe.runCommand(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-o",
			`ConnectTimeout=${Math.ceil(PROBE_TIMEOUT_MS / 1000)}`,
			host,
			"echo ok",
		],
		{ cwd: process.cwd(), timeoutMs: PROBE_TIMEOUT_MS },
	);
	if (result.code !== 0 || !result.stdout.includes("ok")) {
		return {
			name: `ssh ${host}`,
			status: "fail",
			detail: `连不上：${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`,
			fix: "检查 ~/.ssh/config 的 Host 与免密钥登录；远程评测必须能 rsync + ssh",
		};
	}
	return { name: `ssh ${host}`, status: "ok", detail: "免密钥可达" };
}

async function checkTmux(
	host: string,
	probe: DoctorDeps,
): Promise<DoctorCheck> {
	const result = await probe.runCommand(
		"ssh",
		["-o", "BatchMode=yes", host, "command -v tmux || true"],
		{ cwd: process.cwd(), timeoutMs: PROBE_TIMEOUT_MS },
	);
	const available = result.stdout.trim() !== "";
	return {
		name: `tmux on ${host}`,
		status: available ? "ok" : "warn",
		detail: available
			? result.stdout.trim()
			: "没有 tmux，会回退到 nohup（断开 SSH 后日志仍在，但无法 attach）",
		...(available ? {} : { fix: "apt-get install -y tmux，便于观察长跑评测" }),
	};
}

async function checkTelemetry(
	settings: Settings,
	network: boolean,
	probe: DoctorDeps,
): Promise<DoctorCheck> {
	const config = settings.telemetry;
	if (config?.enabled === false) {
		return {
			name: "telemetry",
			status: "warn",
			detail: "遥测已关闭：跑批结果不会出现在远端，跨轮对比只能靠本地文件",
		};
	}
	const endpoint = config?.endpoint;
	if (endpoint === undefined || endpoint.trim() === "") {
		return {
			name: "telemetry",
			status: "warn",
			detail:
				"未配置 endpoint：上报会回退到环境变量/默认值，失败时只打一行 stderr",
		};
	}
	if (!network) {
		return {
			name: "telemetry",
			status: "ok",
			detail: `${endpoint}（未做网络探测）`,
		};
	}
	try {
		const response = await probe.fetchImpl(
			`${endpoint.replace(/\/$/, "")}/healthz`,
			{ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
		);
		await response.body?.cancel().catch(() => {});
		return {
			name: "telemetry",
			status: response.ok ? "ok" : "warn",
			detail: `${endpoint} healthz ${response.status}`,
			...(response.ok
				? {}
				: {
						fix: "服务未就绪时跑批照常，但 report.json 的 telemetry.failed 会记下投递失败",
					}),
		};
	} catch (err) {
		return {
			name: "telemetry",
			status: "warn",
			detail: `${endpoint} 不可达：${err instanceof Error ? err.message : String(err)}`,
			fix: "跑批不受影响；需要远端汇总时先确认服务与 token",
		};
	}
}
