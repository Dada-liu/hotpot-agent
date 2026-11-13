// exp run / exp pull 的集成测试：临时 git 仓库 + 真实 worktree + 注入的子进程执行器。
// 重点验证「一条命令是否真的把两轮跑批和登记做完」，以及失败/中断时是否留下半套证据。

import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExperimentCli } from "../src/experiment/cli.ts";
import { experimentPaths, registryPath } from "../src/experiment/ledger.ts";
import type { BenchmarkReadSource } from "../src/experiment/pull.ts";
import type { CommandExecutor } from "../src/experiment/run.ts";
import type { ExperimentRegistry } from "../src/experiment/types.ts";
import { MANIFEST_FILE, type RunManifest } from "../src/manifest.ts";
import {
	type CommandResult,
	type RunCommandOptions,
	runCommand,
} from "../src/process.ts";
import { buildReport, REPORT_FILE } from "../src/report.ts";
import type {
	QueryWindow,
	RemoteBenchmarkRun,
	RemoteRunDetail,
} from "../src/telemetry-read.ts";
import {
	makeManifest,
	TEST_AGENT_FACTS,
	TEST_MODELS,
} from "./helpers/manifest.ts";

const SLUG = "ctx-budget";
const IDS = Array.from(
	{ length: 10 },
	(_, index) => `django__django-${11000 + index}`,
);
const NOW = "2026-11-13T02:00:00.000Z";
const created: string[] = [];

afterEach(async () => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir === undefined) {
			continue;
		}
		await rm(dir, { recursive: true, force: true });
	}
});

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await runCommand("git", args, { cwd });
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function makeRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hotpot-exp-run-"));
	created.push(dir);
	await git(dir, ["init", "-q", "-b", "main"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "test"]);
	await writeFile(join(dir, "README.md"), "# fixture\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

interface CliRun {
	code: number;
	out: string;
	err: string;
}

async function run(
	cwd: string,
	argv: string[],
	extra: {
		exec?: CommandExecutor;
		readSource?: BenchmarkReadSource;
	} = {},
): Promise<CliRun> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runExperimentCli(argv, {
		cwd,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		now: () => new Date(NOW),
		...(extra.exec === undefined ? {} : { exec: extra.exec }),
		...(extra.readSource === undefined ? {} : { readSource: extra.readSource }),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

async function setup(repo: string, withInstances = true): Promise<void> {
	if (withInstances) {
		await writeFile(
			join(repo, "instances.jsonl"),
			IDS.map((id) => `${JSON.stringify({ instance_id: id })}\n`).join(""),
		);
	}
	const createdExp = await run(repo, [
		"new",
		SLUG,
		"--hypothesis",
		"上下文预算能减少 max_tokens 失败",
	]);
	expect(createdExp.code).toBe(0);
	const head = join(repo, `.worktrees/${SLUG}`);
	await writeFile(join(head, "feature.txt"), "candidate\n");
	await git(head, ["add", "."]);
	await git(head, ["commit", "-q", "-m", "add feature"]);
}

async function readRegistryOf(repo: string): Promise<ExperimentRegistry> {
	return JSON.parse(
		await readFile(registryPath(repo), "utf8"),
	) as ExperimentRegistry;
}

interface FakeRunSpec {
	dir: string;
	commit: string;
	runId: string;
	passedPerInstance: number[];
	status?: "completed" | "running";
}

async function writeFakeRun(spec: FakeRunSpec): Promise<void> {
	await mkdir(spec.dir, { recursive: true });
	const manifest: RunManifest = makeManifest({
		suite: "swebench",
		repeat: 3,
		status: spec.status ?? "completed",
		agent: { ...TEST_AGENT_FACTS, git: { commit: spec.commit, dirty: false } },
		models: TEST_MODELS,
		selection: {
			dataset: "SWE-bench/SWE-bench_Lite",
			split: "test",
			count: IDS.length,
			idsHash: "same-ids",
		},
	});
	manifest.runId = spec.runId;
	const results = IDS.flatMap((instanceId, index) =>
		Array.from({ length: 3 }, (_, attempt) => ({
			instanceId,
			attempt: attempt + 1,
			passed: attempt < (spec.passedPerInstance[index] ?? 0),
			durationMs: 1000,
			inputTokens: 100,
			outputTokens: 10,
		})),
	);
	const report = buildReport(results, undefined, {
		suite: "swebench",
		dataset: "SWE-bench/SWE-bench_Lite",
		split: "test",
		manifest,
	});
	await writeFile(
		join(spec.dir, MANIFEST_FILE),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	await writeFile(
		join(spec.dir, REPORT_FILE),
		`${JSON.stringify(report, null, 2)}\n`,
	);
}

interface ExecCall {
	command: string;
	args: string[];
	cwd: string;
}

function ok(stdout = ""): CommandResult {
	return { code: 0, stdout, stderr: "", timedOut: false };
}

function makeExec(
	calls: ExecCall[],
	opts: { failVariant?: "base" | "head" } = {},
): CommandExecutor {
	return async (
		command: string,
		args: string[],
		options: RunCommandOptions,
	): Promise<CommandResult> => {
		calls.push({ command, args, cwd: options.cwd });
		options.onStdout?.(`fake stdout: ${args.join(" ")}\n`);
		if (command !== "pnpm" || args[0] !== "bench") {
			return ok();
		}
		const variant = options.cwd.endsWith("-base") ? "base" : "head";
		if (opts.failVariant === variant) {
			return {
				code: 1,
				stdout: "",
				stderr: "harness exploded\nlast line",
				timedOut: false,
			};
		}
		const outputIndex = args.indexOf("--output");
		const output = args[outputIndex + 1];
		if (output === undefined) {
			throw new Error("fake exec: bench 缺少 --output");
		}
		const commit = await git(options.cwd, ["rev-parse", "HEAD"]);
		await writeFakeRun({
			dir: output,
			commit,
			runId: `run-${variant}`,
			passedPerInstance: IDS.map((_, index) =>
				index < (variant === "base" ? 5 : 8) ? 3 : 0,
			),
		});
		return ok();
	};
}

function remoteRun(
	runId: string,
	overrides: Partial<RemoteBenchmarkRun> = {},
): RemoteBenchmarkRun {
	return {
		runId,
		benchmark: "swebench",
		dataset: "SWE-bench/SWE-bench_Lite",
		split: "test",
		commit: null,
		model: "kimi-k2",
		tier: "high",
		tasksetHash: null,
		firstSeen: NOW,
		lastSeen: NOW,
		instances: 10,
		attempts: 30,
		passed: runId === "run-head" ? 24 : 15,
		passRate: runId === "run-head" ? 80 : 50,
		resolvedInstances: runId === "run-head" ? 8 : 5,
		flakyInstances: 0,
		inputTokens: 3000,
		outputTokens: 300,
		avgDurationMs: 1000,
		tokensPerResolved: 220,
		...overrides,
	};
}

function fakeSource(
	runs: RemoteBenchmarkRun[],
	opts: { detailFails?: boolean } = {},
): BenchmarkReadSource {
	return {
		endpoint: "http://telemetry.test:8080",
		async benchmarkRuns(_window: QueryWindow) {
			return runs;
		},
		async benchmarkRunDetail(
			runId: string,
			_window: QueryWindow,
		): Promise<RemoteRunDetail> {
			if (opts.detailFails === true) {
				throw new Error("detail unavailable");
			}
			return {
				runId,
				instances: IDS.map((instanceId) => ({
					instanceId,
					attempts: 3,
					passed: 3,
					passRate: 100,
					flaky: false,
					details: [],
				})),
				truncated: false,
			};
		},
	};
}

describe("pnpm exp run", () => {
	it("dry-run 打印完整可执行命令，不执行也不写台账", async () => {
		const repo = await makeRepo();
		await setup(repo);
		const calls: ExecCall[] = [];
		const result = await run(repo, ["run", SLUG, "--dry-run"], {
			exec: makeExec(calls),
		});
		expect(result.code).toBe(0);
		expect(calls).toHaveLength(0);
		expect(result.out).toContain("--suite lite10");
		expect(result.out).toContain("--repeat 3");
		expect(result.out).toContain("pnpm install");
		expect(result.out).toContain(
			join(repo, "benchmark-runs", "experiments", SLUG, "base"),
		);
		expect(result.out).toContain("[dry-run] 不会执行任何命令");
		const registry = await readRegistryOf(repo);
		expect(registry.experiments[0]?.runs).toEqual([]);
	});

	it("实例文件缺失时开跑前就拦住，不花一分钱", async () => {
		const repo = await makeRepo();
		await setup(repo, false);
		const calls: ExecCall[] = [];
		const result = await run(repo, ["run", SLUG], {
			exec: makeExec(calls),
		});
		expect(result.code).toBe(1);
		expect(result.err).toContain("实例文件不存在");
		expect(result.err).toContain("export_instances.py");
		expect(calls).toHaveLength(0);
	});

	it("顺序跑完两轮、日志落盘，并自动登记出对比结论", async () => {
		const repo = await makeRepo();
		await setup(repo);
		const calls: ExecCall[] = [];
		const result = await run(repo, ["run", SLUG], {
			exec: makeExec(calls),
		});
		expect(result.code).toBe(0);
		const benchCalls = calls.filter(
			(call) => call.command === "pnpm" && call.args[0] === "bench",
		);
		expect(benchCalls).toHaveLength(2);
		expect(benchCalls[0]?.cwd.endsWith("-base")).toBe(true);
		expect(benchCalls[1]?.cwd.endsWith(`/${SLUG}`)).toBe(true);
		expect(benchCalls[0]?.args).toContain("--suite");
		expect(benchCalls[0]?.args).toContain("lite10");
		expect(calls.filter((call) => call.args[0] === "install")).toHaveLength(2);

		const paths = experimentPaths(repo, SLUG);
		expect(existsSync(join(paths.runsRoot, "base", "exp-run.log"))).toBe(true);
		const log = await readFile(
			join(paths.runsRoot, "head", "exp-run.log"),
			"utf8",
		);
		expect(log).toContain("$ pnpm bench swebench");
		expect(log).toContain("fake stdout");

		const registry = await readRegistryOf(repo);
		const record = registry.experiments[0];
		expect(record?.runs.map((item) => item.variant).sort()).toEqual([
			"base",
			"head",
		]);
		expect(record?.runs.map((item) => item.runId).sort()).toEqual([
			"run-base",
			"run-head",
		]);
		expect(record?.comparison?.verdict).toBe("better");
		const doc = await readFile(paths.docPath, "utf8");
		expect(doc).toContain("## 远端遥测回读");
		expect(doc).toContain("pnpm exp run ctx-budget");
	});

	it("任一变体失败立即停止，且不登记任何半套证据", async () => {
		const repo = await makeRepo();
		await setup(repo);
		const calls: ExecCall[] = [];
		const result = await run(repo, ["run", SLUG], {
			exec: makeExec(calls, { failVariant: "head" }),
		});
		expect(result.code).toBe(1);
		expect(result.err).toContain("harness exploded");
		expect(result.err).toContain("不会自动登记");
		const registry = await readRegistryOf(repo);
		expect(registry.experiments[0]?.runs).toEqual([]);
		expect(registry.experiments[0]?.comparison).toBeUndefined();
		// base 的产物与日志保留，重跑时可复用
		expect(
			existsSync(
				join(experimentPaths(repo, SLUG).runsRoot, "base", REPORT_FILE),
			),
		).toBe(true);
	});

	it("已有完成的跑批会跳过，未完成的带 --resume", async () => {
		const repo = await makeRepo();
		await setup(repo);
		const paths = experimentPaths(repo, SLUG);
		const baseCommit = await git(repo, ["rev-parse", "HEAD"]);
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit: baseCommit,
			runId: "run-base-done",
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		// head 只留 manifest（上次没走完收尾）
		const headCommit = await git(join(repo, `.worktrees/${SLUG}`), [
			"rev-parse",
			"HEAD",
		]);
		await writeFakeRun({
			dir: join(paths.runsRoot, "head"),
			commit: headCommit,
			runId: "run-head-partial",
			passedPerInstance: IDS.map((_, index) => (index < 8 ? 3 : 0)),
			status: "running",
		});
		await rm(join(paths.runsRoot, "head", REPORT_FILE));

		const calls: ExecCall[] = [];
		const result = await run(repo, ["run", SLUG, "--skip-install"], {
			exec: makeExec(calls),
		});
		expect(result.code).toBe(0);
		expect(result.out).toContain("复用");
		const benchCalls = calls.filter((call) => call.args[0] === "bench");
		expect(benchCalls).toHaveLength(1);
		expect(benchCalls[0]?.args).toContain("--resume");
		expect(calls.filter((call) => call.args[0] === "install")).toHaveLength(0);
		const registry = await readRegistryOf(repo);
		expect(registry.experiments[0]?.runs).toHaveLength(2);
	});

	it("--force 把旧产物移为 .bak 而不是覆盖", async () => {
		const repo = await makeRepo();
		await setup(repo);
		const paths = experimentPaths(repo, SLUG);
		const baseCommit = await git(repo, ["rev-parse", "HEAD"]);
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit: baseCommit,
			runId: "run-old",
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		await writeFile(join(paths.runsRoot, "base", "keep.txt"), "old artifact\n");
		const result = await run(repo, ["run", SLUG, "--force", "--skip-install"], {
			exec: makeExec([]),
		});
		expect(result.code).toBe(0);
		const entries = await readdir(paths.runsRoot);
		expect(entries.some((entry) => entry.startsWith("base.bak-"))).toBe(true);
		expect(existsSync(join(paths.runsRoot, "base", "keep.txt"))).toBe(false);
	});
});

describe("pnpm exp pull", () => {
	async function repoWithRuns(): Promise<string> {
		const repo = await makeRepo();
		await setup(repo);
		const result = await run(repo, ["run", SLUG], { exec: makeExec([]) });
		expect(result.code).toBe(0);
		return repo;
	}

	it("远端与本地一致时落盘明细并把摘要写进台账", async () => {
		const repo = await repoWithRuns();
		const source = fakeSource([remoteRun("run-base"), remoteRun("run-head")]);
		const result = await run(repo, ["pull", SLUG], { readSource: source });
		expect(result.code).toBe(0);
		expect(result.out).toContain("本地/远端");
		expect(result.out).toContain("结论：远端与本地报告一致");
		const registry = await readRegistryOf(repo);
		expect(registry.experiments[0]?.telemetry?.runs).toHaveLength(2);
		expect(
			registry.experiments[0]?.telemetry?.runs.every(
				(item) => item.status === "ok",
			),
		).toBe(true);
		const detail = JSON.parse(
			await readFile(
				join(experimentPaths(repo, SLUG).runsRoot, "telemetry.json"),
				"utf8",
			),
		) as { checks: { status: string }[] };
		expect(detail.checks).toHaveLength(2);
		const doc = await readFile(experimentPaths(repo, SLUG).docPath, "utf8");
		expect(doc).toContain("逐项一致：远端数据与本地报告对得上");
	});

	it("远端少一条事件时给出 mismatch 与非零退出码", async () => {
		const repo = await repoWithRuns();
		const source = fakeSource([
			remoteRun("run-base", { passed: 14, passRate: 46.67 }),
			remoteRun("run-head"),
		]);
		const result = await run(repo, ["pull", SLUG], { readSource: source });
		expect(result.code).toBe(1);
		expect(result.err).toContain("通过次数 本地 15 / 远端 14");
		expect(result.err).toContain("退出码 1 表示对账不一致");
		const registry = await readRegistryOf(repo);
		expect(registry.experiments[0]?.telemetry?.runs[0]?.status).toBe(
			"mismatch",
		);
	});

	it("远端查不到 runId 时标 missing，不把空列表当成功", async () => {
		const repo = await repoWithRuns();
		const result = await run(repo, ["pull", SLUG, "--no-save"], {
			readSource: fakeSource([]),
		});
		expect(result.code).toBe(1);
		expect(result.err).toContain("远端查不到 runId");
		expect(result.out).toContain("未写台账");
		const registry = await readRegistryOf(repo);
		expect(registry.experiments[0]?.telemetry).toBeUndefined();
	});

	it("run --pull 串联：跑批成功后自动回读并留痕", async () => {
		const repo = await makeRepo();
		await setup(repo);
		const source = fakeSource([remoteRun("run-base"), remoteRun("run-head")]);
		const result = await run(repo, ["run", SLUG, "--pull", "--skip-install"], {
			exec: makeExec([]),
			readSource: source,
		});
		expect(result.code).toBe(0);
		expect(result.out).toContain("远端回读");
		const registry = await readRegistryOf(repo);
		expect(registry.experiments[0]?.runs).toHaveLength(2);
		expect(registry.experiments[0]?.telemetry?.runs).toHaveLength(2);
	});
});
