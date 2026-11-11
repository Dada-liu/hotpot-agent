// 运行清单（manifest）：一次跑批的「身份证明」，可比较性的唯一依据。
// report.json 里只有结果，光看结果无法判断两次跑批是否同一实验条件——
// Lite10 与 Lite300 就只能靠文档手写「模型不同、不能对比」。manifest 把这些条件变成数据：
// 代码版本、模型与档位、运行档（特性开关/并行/超时/patch-only）、题目集哈希、评测方式。
//
// 纪律：
// - 只存可比对的事实：不存 apiKey，不存完整 baseUrl（可能带查询串/凭证），只留 host + path。
// - status=running 表示跑批未走完（进程被杀/抛错），此时目录里的结果不可用于结论。
// - 题目集用哈希而不是列表：id 集合哈希管「选了哪些题」，tasksetHash 管「题本身改了没」。

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelTier, Settings } from "@hotpot/core";
import { APP_VERSION } from "@hotpot/telemetry";
import { runCommand } from "./process.ts";
import type { BenchmarkRuntime } from "./runtime-profile.ts";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";

export type BenchmarkSuite = "swebench" | "custom";

export type RunStatus = "running" | "completed" | "failed";

export interface GitState {
	// null 表示取不到（不在 git 仓库 / 没装 git），不是「干净」
	commit: string | null;
	dirty: boolean | null;
}

export interface AgentFacts {
	packageVersion: string;
	git: GitState;
	node: string;
	// process.platform（darwin/linux/win32）：耗时类指标跨平台不可比
	platform: string;
}

export interface ModelFingerprint {
	provider: string;
	model: string;
	// baseUrl 省略时走各 provider 官方端点，记为 null
	baseUrlHost: string | null;
	baseUrlPath: string | null;
}

export interface ManifestSelection {
	dataset?: string;
	split?: string;
	seed?: number;
	limit?: number;
	count: number;
	// 实际选中题目 id 的 sha256：集合不同即不可比
	idsHash: string;
	// 自建题的题目内容哈希（题面/校验脚本改动会让旧基线失效）
	tasksetHash?: string;
	// 分片信息：只有共享同一 parentIdsHash 的分片才允许 merge
	shard?: { index: number; count: number };
	// 分片前的完整选择集合；非分片运行缺省
	parentIdsHash?: string;
	parentCount?: number;
}

export interface ManifestEvaluation {
	mode: "local" | "remote";
	maxWorkers: number;
	host?: string;
}

export interface RunManifest {
	schemaVersion: 1;
	runId: string;
	suite: BenchmarkSuite;
	status: RunStatus;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	agent: AgentFacts;
	models: Record<ModelTier, ModelFingerprint>;
	mainAgentTier: ModelTier;
	runtime: BenchmarkRuntime;
	selection: ManifestSelection;
	eval?: ManifestEvaluation;
}

export interface CreateRunManifestOptions {
	runId: string;
	suite: BenchmarkSuite;
	startedAt: string;
	agent: AgentFacts;
	models: Record<ModelTier, ModelFingerprint>;
	mainAgentTier: ModelTier;
	runtime: BenchmarkRuntime;
	selection: ManifestSelection;
	eval?: ManifestEvaluation;
}

export function createRunManifest(opts: CreateRunManifestOptions): RunManifest {
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		runId: opts.runId,
		suite: opts.suite,
		status: "running",
		startedAt: opts.startedAt,
		agent: opts.agent,
		models: opts.models,
		mainAgentTier: opts.mainAgentTier,
		runtime: opts.runtime,
		selection: opts.selection,
		...(opts.eval === undefined ? {} : { eval: opts.eval }),
	};
}

export interface FinalizeRunManifestOptions {
	status: Exclude<RunStatus, "running">;
	finishedAt: string;
	durationMs: number;
}

export function finalizeRunManifest(
	manifest: RunManifest,
	opts: FinalizeRunManifestOptions,
): RunManifest {
	return {
		...manifest,
		status: opts.status,
		finishedAt: opts.finishedAt,
		durationMs: opts.durationMs,
	};
}

// 采集代码侧事实。git 取不到不报错：跑批可能发生在导出的 tarball 或 CI 浅克隆里，
// 但这会让 comparability 判定退化为「commit 未知」，由 describeManifestDiff 明确说出来。
export async function collectAgentFacts(
	cwd: string,
	packageVersion: string = APP_VERSION,
): Promise<AgentFacts> {
	const commit = await gitOutput(cwd, ["rev-parse", "HEAD"]);
	const status = await gitOutput(cwd, ["status", "--porcelain"]);
	return {
		packageVersion,
		git: {
			commit: commit === null || commit === "" ? null : commit,
			dirty: status === null ? null : status !== "",
		},
		node: process.version,
		platform: process.platform,
	};
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
	const result = await runCommand("git", args, { cwd, timeoutMs: 5000 });
	if (result.code !== 0) {
		return null;
	}
	// commit 与 status 都按整体 trim 判定：干净仓库的 porcelain 输出为空串
	return result.stdout.trim();
}

export function collectModelFingerprints(
	models: Settings["models"],
): Record<ModelTier, ModelFingerprint> {
	return {
		high: fingerprint(models.high),
		medium: fingerprint(models.medium),
		low: fingerprint(models.low),
	};
}

function fingerprint(ref: Settings["models"][ModelTier]): ModelFingerprint {
	const parsed = parseBaseUrl(ref.baseUrl);
	return {
		provider: ref.provider,
		model: ref.model,
		baseUrlHost: parsed.host,
		baseUrlPath: parsed.path,
	};
}

function parseBaseUrl(baseUrl: string | undefined): {
	host: string | null;
	path: string | null;
} {
	if (baseUrl === undefined) {
		return { host: null, path: null };
	}
	try {
		const url = new URL(baseUrl);
		return { host: url.host, path: url.pathname };
	} catch {
		// 非法 baseUrl 仍要参与比较：记成标记而不是原串，避免把疑似凭证写进报告
		return { host: "<invalid>", path: null };
	}
}

export function hashStrings(values: readonly string[]): string {
	const hash = createHash("sha256");
	for (const value of values) {
		hash.update(value);
		hash.update("\n");
	}
	return hash.digest("hex");
}

// 题目集哈希：按 id 排序 + 键名排序后再序列化，保证「只是 JSON 键顺序不同」不会被判成题目变了。
export function hashTaskSet(tasks: readonly { id: string }[]): string {
	const ordered = [...tasks].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	return hashStrings(ordered.map((task) => stableStringify(task)));
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
		.join(",")}}`;
}

export async function writeRunManifest(
	manifest: RunManifest,
	outputDir: string,
): Promise<string> {
	await mkdir(outputDir, { recursive: true });
	const path = join(outputDir, MANIFEST_FILE);
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
	return path;
}

export async function readRunManifest(path: string): Promise<RunManifest> {
	const text = await readFile(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`benchmark manifest is not valid JSON: ${path}`);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		(value as { schemaVersion?: unknown }).schemaVersion !==
			MANIFEST_SCHEMA_VERSION
	) {
		throw new Error(
			`unsupported benchmark manifest (expected schemaVersion ${MANIFEST_SCHEMA_VERSION}): ${path}`,
		);
	}
	return value as RunManifest;
}

// 可比性判定：返回空数组表示两次跑批是同一实验条件。
// 只比较会影响结论的字段；runId/时间戳/耗时天然不同，不参与比较。
export function describeManifestDiff(a: RunManifest, b: RunManifest): string[] {
	const diffs: string[] = [];
	const push = (field: string, left: unknown, right: unknown): void => {
		if (JSON.stringify(left) !== JSON.stringify(right)) {
			diffs.push(`${field}: ${format(left)} -> ${format(right)}`);
		}
	};

	if (a.suite !== b.suite) {
		diffs.push(`suite: ${a.suite} -> ${b.suite}`);
	}
	push("runtime profile", a.runtime, b.runtime);
	for (const tier of ["high", "medium", "low"] as const) {
		push(`model tier ${tier}`, a.models[tier], b.models[tier]);
	}
	push("main agent tier", a.mainAgentTier, b.mainAgentTier);
	push("git commit", a.agent.git.commit, b.agent.git.commit);
	push("agent package version", a.agent.packageVersion, b.agent.packageVersion);
	push("selected instances", a.selection.idsHash, b.selection.idsHash);
	push("task set", a.selection.tasksetHash, b.selection.tasksetHash);
	push("dataset", a.selection.dataset, b.selection.dataset);
	push("split", a.selection.split, b.selection.split);
	push("evaluation mode", a.eval?.mode, b.eval?.mode);
	return diffs;
}

export function isComparable(a: RunManifest, b: RunManifest): boolean {
	return describeManifestDiff(a, b).length === 0;
}

// 比较前先把「分片视角」归一到「父集合视角」：
// 三个分片各自只跑了一部分题，按各自 idsHash 比永远不可比，
// 但它们共享 parentIdsHash——那才是「这些结果能否拼成一轮」的判据。
export function manifestForComparison(manifest: RunManifest): RunManifest {
	if (
		manifest.selection.shard === undefined &&
		manifest.selection.parentIdsHash === undefined
	) {
		return manifest;
	}
	return {
		...manifest,
		selection: {
			dataset: manifest.selection.dataset,
			split: manifest.selection.split,
			seed: manifest.selection.seed,
			limit: manifest.selection.limit,
			tasksetHash: manifest.selection.tasksetHash,
			idsHash: manifest.selection.parentIdsHash ?? manifest.selection.idsHash,
			count: manifest.selection.parentCount ?? manifest.selection.count,
		},
	};
}

function format(value: unknown): string {
	if (value === undefined) {
		return "(absent)";
	}
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}
