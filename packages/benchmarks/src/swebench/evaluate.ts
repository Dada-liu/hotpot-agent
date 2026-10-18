// 官方评测编排：只负责拼官方命令、跑 harness、回收 report；不实现任何评分逻辑。
// local：在当前机器的 python 环境里执行（通常已激活 swebench venv）。
// remote：rsync 预测到 --eval-host，在 tmux 中跑同一命令（tmux 缺失时回退 nohup），
// 轮询完成标记后把 report 目录拉回本地。
// 失败语义：harness 退出码非 0 或 report 缺失都抛错，错误里带日志路径，
// 绝不把「没有 report」当成 0 通过。

import { existsSync } from "node:fs";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { runCommand } from "../process.ts";

const DEFAULT_HF_ENDPOINT = "https://hf-mirror.com";
const REMOTE_ROOT = "hotpot-bench";
const REMOTE_POLL_INTERVAL_MS = 5000;
const DEFAULT_REMOTE_TIMEOUT_MS = 21600000;

export interface BuildEvaluationCommandOptions {
	dataset: string;
	split: string;
	predictionsPath: string;
	maxWorkers: number;
	runId: string;
	reportDir: string;
}

export interface RunOfficialEvaluationOptions
	extends BuildEvaluationCommandOptions {
	mode: "local" | "remote";
	host: string;
	cwd: string;
}

export interface OfficialReport {
	runId: string;
	resolved: string[];
	unresolved: string[];
	emptyPatch: string[];
}

export function buildEvaluationCommand(
	opts: BuildEvaluationCommandOptions,
): string[] {
	return [
		"python3",
		"-m",
		"swebench.harness.run_evaluation",
		"--dataset_name",
		opts.dataset,
		"--split",
		opts.split,
		"--predictions_path",
		opts.predictionsPath,
		"--max_workers",
		String(opts.maxWorkers),
		"--run_id",
		opts.runId,
		"--report_dir",
		opts.reportDir,
	];
}

export async function runOfficialEvaluation(
	opts: RunOfficialEvaluationOptions,
): Promise<OfficialReport> {
	const reportDir = isAbsolute(opts.reportDir)
		? opts.reportDir
		: join(opts.cwd, opts.reportDir);
	await mkdir(reportDir, { recursive: true });
	const argv = buildEvaluationCommand({ ...opts, reportDir });

	if (opts.mode === "local") {
		return runLocal(argv, opts, reportDir);
	}
	return runRemote(argv, opts, reportDir);
}

async function runLocal(
	argv: string[],
	opts: RunOfficialEvaluationOptions,
	reportDir: string,
): Promise<OfficialReport> {
	const logPath = join(reportDir, `${opts.runId}.log`);
	await writeFile(logPath, "");
	let logChain: Promise<void> = Promise.resolve();
	const appendLog = (text: string): void => {
		logChain = logChain
			.then(() => appendFile(logPath, text))
			.catch(() => {
				// 日志写失败不影响评测本身
			});
	};

	const [command, ...args] = argv;
	if (command === undefined) {
		throw new Error("empty evaluation command");
	}
	const result = await runCommand(command, args, {
		cwd: opts.cwd,
		env: { HF_ENDPOINT: process.env.HF_ENDPOINT ?? DEFAULT_HF_ENDPOINT },
		onStdout: appendLog,
		onStderr: appendLog,
	});
	await logChain;
	if (result.code !== 0) {
		throw new Error(
			`official evaluation failed (exit ${result.code}); log: ${logPath}`,
		);
	}

	const reportFile = await findReportFile(reportDir, opts.runId);
	if (reportFile === null) {
		throw new Error(
			`official evaluation report not found under ${reportDir}; log: ${logPath}`,
		);
	}
	const report = await parseOfficialReport(reportFile);
	return { ...report, runId: opts.runId };
}

async function runRemote(
	argv: string[],
	opts: RunOfficialEvaluationOptions,
	reportDir: string,
): Promise<OfficialReport> {
	const runId = safeRunId(opts.runId);
	const remoteDir = `~/${REMOTE_ROOT}/${runId}`;
	const session = `hotpot-bench-${runId}`;
	const logPath = join(reportDir, `${opts.runId}.remote.log`);

	const reachable = await runCommand("ssh", [opts.host, "true"], {
		cwd: opts.cwd,
		timeoutMs: 60000,
	});
	if (reachable.code !== 0) {
		throw new Error(
			`cannot reach evaluation host ${opts.host}: ${lastLine(reachable.stderr)}`,
		);
	}

	const made = await runCommand(
		"ssh",
		[opts.host, `mkdir -p ${remoteDir}/report`],
		{ cwd: opts.cwd, timeoutMs: 60000 },
	);
	if (made.code !== 0) {
		throw new Error(
			`cannot create ${remoteDir} on ${opts.host}: ${lastLine(made.stderr)}`,
		);
	}

	const pushPredictions = await runCommand(
		"rsync",
		[
			"-az",
			opts.predictionsPath,
			`${opts.host}:${remoteDir}/predictions.jsonl`,
		],
		{ cwd: opts.cwd, timeoutMs: 600000 },
	);
	if (pushPredictions.code !== 0) {
		throw new Error(
			`cannot upload predictions to ${opts.host}: ${lastLine(pushPredictions.stderr)}`,
		);
	}

	// 远程脚本显式尝试 macmini 约定的 venv；不存在时退回系统 python3。
	// 参数经单引号转义，避免 dataset/run id 影响 shell 解析。
	const remoteArgv = argv.slice(1).map(shellQuote).join(" ");
	const script = [
		"#!/bin/bash",
		"set -u",
		`cd ${remoteDir} || exit 2`,
		'if [ -f "$HOME/swebench-venv/bin/activate" ]; then . "$HOME/swebench-venv/bin/activate"; fi',
		`export HF_ENDPOINT="\${HF_ENDPOINT:-${DEFAULT_HF_ENDPOINT}}"`,
		`python3 ${remoteArgv} > report/harness.log 2>&1`,
		"echo $? > report/exit-code",
		"",
	].join("\n");
	const scriptPath = join(reportDir, `${opts.runId}.remote.sh`);
	await writeFile(scriptPath, script);
	const pushScript = await runCommand(
		"rsync",
		["-az", scriptPath, `${opts.host}:${remoteDir}/run.sh`],
		{ cwd: opts.cwd, timeoutMs: 600000 },
	);
	if (pushScript.code !== 0) {
		throw new Error(
			`cannot upload runner script to ${opts.host}: ${lastLine(pushScript.stderr)}`,
		);
	}

	const started = await runCommand(
		"ssh",
		[opts.host, `tmux new-session -d -s ${session} "bash ${remoteDir}/run.sh"`],
		{ cwd: opts.cwd, timeoutMs: 60000 },
	);
	const usingTmux = started.code === 0;
	if (!usingTmux) {
		// tmux 缺失（macmini 默认未装）：nohup 后台跑，完成标记仍由 exit-code 判断
		const fallback = await runCommand(
			"ssh",
			[
				opts.host,
				`cd ${remoteDir} && nohup bash run.sh > report/nohup.log 2>&1 & echo started`,
			],
			{ cwd: opts.cwd, timeoutMs: 60000 },
		);
		if (fallback.code !== 0) {
			throw new Error(
				`cannot start remote evaluation on ${opts.host}: ${lastLine(fallback.stderr)}`,
			);
		}
	}

	const deadline = Date.now() + DEFAULT_REMOTE_TIMEOUT_MS;
	let finished = false;
	while (Date.now() < deadline) {
		const exitCode = await runCommand(
			"ssh",
			[opts.host, `cat ${remoteDir}/report/exit-code 2>/dev/null`],
			{ cwd: opts.cwd, timeoutMs: 60000 },
		);
		if (exitCode.code === 0 && exitCode.stdout.trim() !== "") {
			finished = true;
			break;
		}
		if (usingTmux) {
			const alive = await runCommand(
				"ssh",
				[opts.host, `tmux has-session -t ${session}`],
				{ cwd: opts.cwd, timeoutMs: 60000 },
			);
			if (alive.code !== 0) {
				// tmux 会话结束但没写标记：可能脚本崩溃，再探一次标记后退出
				const last = await runCommand(
					"ssh",
					[opts.host, `cat ${remoteDir}/report/exit-code 2>/dev/null`],
					{ cwd: opts.cwd, timeoutMs: 60000 },
				);
				finished = last.code === 0 && last.stdout.trim() !== "";
				break;
			}
		}
		await sleep(REMOTE_POLL_INTERVAL_MS);
	}
	if (!finished) {
		throw new Error(
			`remote evaluation timed out after ${DEFAULT_REMOTE_TIMEOUT_MS}ms; see ${logPath}`,
		);
	}

	const pulled = await runCommand(
		"rsync",
		["-az", `${opts.host}:${remoteDir}/report/`, `${reportDir}/`],
		{ cwd: opts.cwd, timeoutMs: 600000 },
	);
	if (pulled.code !== 0) {
		throw new Error(
			`cannot download evaluation report from ${opts.host}: ${lastLine(pulled.stderr)}`,
		);
	}
	// 远程日志也拉一份，方便失败时直接看
	await runCommand(
		"rsync",
		["-az", `${opts.host}:${remoteDir}/report/harness.log`, logPath],
		{ cwd: opts.cwd, timeoutMs: 600000 },
	);

	const exitCodePath = join(reportDir, "exit-code");
	const exitCode = existsSync(exitCodePath)
		? (await readFile(exitCodePath, "utf8")).trim()
		: "";
	if (exitCode !== "0") {
		throw new Error(
			`official evaluation failed (exit ${exitCode || "unknown"}); log: ${logPath}`,
		);
	}
	const reportFile = await findReportFile(reportDir, opts.runId);
	if (reportFile === null) {
		throw new Error(
			`official evaluation report not found under ${reportDir}; log: ${logPath}`,
		);
	}
	const report = await parseOfficialReport(reportFile);
	return { ...report, runId: opts.runId };
}

// 官方 report 的路径随 swebench 版本变化：优先 <reportDir>/<runId>.json，
// 再找 <reportDir>/<model_name>.<runId>.json（swebench 5.x 实际命名）、
// <reportDir>/<runId>/report.json 与 <reportDir>/report.json；
// 最后在 reportDir 下浅层扫描带 resolved 字段的 JSON，避免版本差异直接判失败。
export async function findReportFile(
	reportDir: string,
	runId: string,
): Promise<string | null> {
	const candidates = [
		join(reportDir, `${runId}.json`),
		join(reportDir, `hotpot-code.${runId}.json`),
		join(reportDir, runId, "report.json"),
		join(reportDir, "report.json"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	const scanned = await scanForReport(reportDir, 3);
	return scanned;
}

async function scanForReport(
	dir: string,
	depth: number,
): Promise<string | null> {
	if (depth < 0) {
		return null;
	}
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const path = join(dir, entry);
		try {
			const text = await readFile(path, "utf8");
			if (text.includes('"resolved_ids"') || text.includes('"resolved"')) {
				return path;
			}
		} catch {
			// 不可读文件跳过
		}
	}
	for (const entry of entries) {
		if (entry.endsWith(".json")) {
			continue;
		}
		const nested = await scanForReport(join(dir, entry), depth - 1);
		if (nested !== null) {
			return nested;
		}
	}
	return null;
}

export async function parseOfficialReport(
	file: string,
): Promise<OfficialReport> {
	const text = await readFile(file, "utf8");
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`official report is not valid JSON: ${file}`);
	}
	if (!isRecord(raw)) {
		throw new Error(`official report must be a JSON object: ${file}`);
	}

	const results = raw.results;
	const resolved =
		stringArray(raw.resolved_ids) ??
		stringArray(raw.resolved) ??
		idsFromResults(results, true);
	const unresolved =
		stringArray(raw.unresolved_ids) ??
		stringArray(raw.unresolved) ??
		idsFromResults(results, false);
	if (resolved === null || unresolved === null) {
		throw new Error(
			`official report has no resolvable instance lists: ${file}`,
		);
	}
	const emptyPatch =
		stringArray(raw.empty_patch_ids) ?? stringArray(raw.empty_patch) ?? [];
	const runId =
		typeof raw.run_id === "string"
			? raw.run_id
			: basename(file).replace(/\.json$/, "");
	return { runId, resolved, unresolved, emptyPatch };
}

function idsFromResults(
	value: unknown,
	wantResolved: boolean,
): string[] | null {
	if (!isRecord(value)) {
		return null;
	}
	const entries = Object.entries(value).filter(
		(entry): entry is [string, Record<string, unknown>] =>
			isRecord(entry[1]) && typeof entry[1].resolved === "boolean",
	);
	if (entries.length === 0) {
		return null;
	}
	return entries
		.filter(([, result]) => result.resolved === wantResolved)
		.map(([id]) => id);
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRunId(runId: string): string {
	const safe = runId.replace(/[^A-Za-z0-9_.-]/g, "-");
	return safe === "" ? "run" : safe;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function lastLine(text: string): string {
	const lines = text.trim().split("\n");
	return lines[lines.length - 1] ?? text.trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
