// 合并分片：把 n 个分片目录的结果拼成「一轮」。
//
// 合并是评测体系里最容易骗自己的地方：随便把几个 report 的题数加起来，
// 得到的 passRate 看着像真的，其实可能来自不同模型、不同 commit、重叠的题。
// 所以这里先做三件事，再谈数字：
// 1. 可比性：每个分片归一成「父集合视角」后必须与基准 manifest 完全一致；
// 2. 覆盖性：同一题出现在两个分片里视为错误（说明分片重叠，passRate 会被重复计数）；
// 3. 诚实性：只要有分片没跑完，合并结果的 status 就不是 completed。
//
// verdict 来自各分片的官方评测结果（report.json 的 passed），这里不重新评测。

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	describeManifestDiff,
	hashStrings,
	MANIFEST_FILE,
	manifestForComparison,
	type RunManifest,
	readRunManifest,
} from "./manifest.ts";
import {
	type BenchmarkReport,
	buildReport,
	REPORT_FILE,
	writeReport,
} from "./report.ts";
import {
	PREDICTIONS_FILE,
	type PredictionEntry,
	readPredictions,
	writePredictions,
} from "./swebench/predictions.ts";

export interface RunArtifacts {
	dir: string;
	manifest: RunManifest;
	report: BenchmarkReport;
	predictions: PredictionEntry[];
}

export interface ReadRunArtifactsOptions {
	// resume 场景允许 report 缺失（上一次跑批没走完收尾）
	allowMissingReport?: boolean;
	allowMissingManifest?: boolean;
}

export async function readRunArtifacts(
	dir: string,
	opts: ReadRunArtifactsOptions = {},
): Promise<RunArtifacts> {
	const parsedManifest = await readManifestIfPresent(join(dir, MANIFEST_FILE));
	if (parsedManifest === undefined) {
		if (!opts.allowMissingManifest) {
			throw new Error(`${dir}: ${MANIFEST_FILE} not found`);
		}
		throw new MissingArtifactsError(dir, "manifest");
	}
	const rawReport = await readJsonIfPresent(join(dir, REPORT_FILE));
	if (rawReport === undefined) {
		if (!opts.allowMissingReport) {
			throw new Error(
				`${dir}: ${REPORT_FILE} not found（这轮跑批没有走完收尾）`,
			);
		}
		throw new MissingArtifactsError(dir, "report");
	}
	const report = rawReport as unknown as BenchmarkReport;
	if (
		typeof report.total !== "number" ||
		!Array.isArray(report.instances) ||
		report.manifest?.runId !== parsedManifest.runId
	) {
		throw new Error(
			`${dir}: ${REPORT_FILE} 与 ${MANIFEST_FILE} 不一致（runId 对不上或字段缺失）`,
		);
	}
	const predictions = await readPredictions(join(dir, PREDICTIONS_FILE));
	return { dir, manifest: parsedManifest, report, predictions };
}

async function readManifestIfPresent(
	path: string,
): Promise<RunManifest | undefined> {
	try {
		return await readRunManifest(path);
	} catch (err) {
		if (isMissingFile(err)) {
			return undefined;
		}
		throw err;
	}
}

function isMissingFile(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

export class MissingArtifactsError extends Error {
	constructor(dir: string, kind: "manifest" | "report") {
		super(`${dir}: no ${kind}`);
		this.name = "MissingArtifactsError";
	}
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${path}: invalid JSON`);
	}
}

export interface MergeOptions {
	runId: string;
}

export interface MergeOutcome {
	report: BenchmarkReport;
	predictions: PredictionEntry[];
}

// 纯函数：不做 IO，便于用构造出来的 artifacts 覆盖各种「不该合并」的情形。
export function mergeArtifacts(
	inputs: readonly RunArtifacts[],
	opts: MergeOptions,
): MergeOutcome {
	if (inputs.length === 0) {
		throw new Error("nothing to merge");
	}
	const base = inputs[0];
	if (base === undefined) {
		throw new Error("nothing to merge");
	}
	const baseManifest = manifestForComparison(base.manifest);
	for (const input of inputs.slice(1)) {
		const diffs = describeManifestDiff(
			baseManifest,
			manifestForComparison(input.manifest),
		);
		if (diffs.length > 0) {
			throw new Error(
				`${input.dir} 与 ${base.dir} 不可合并（实验条件不同）：\n  ${diffs.join("\n  ")}`,
			);
		}
	}

	const byId = new Map<
		string,
		{ result: BenchmarkReport["instances"][number]; patch: string; dir: string }
	>();
	for (const input of inputs) {
		const patches = new Map(
			input.predictions.map((entry) => [entry.instanceId, entry.patch]),
		);
		for (const result of input.report.instances) {
			const existing = byId.get(result.instanceId);
			if (existing !== undefined) {
				// 同一题被两个分片都跑了：合并会把这一题计两次，passRate 直接失真
				throw new Error(
					`instance ${result.instanceId} 同时出现在 ${existing.dir} 与 ${input.dir}：分片重叠，拒绝合并`,
				);
			}
			byId.set(result.instanceId, {
				result,
				patch: patches.get(result.instanceId) ?? "",
				dir: input.dir,
			});
		}
	}

	const ids = [...byId.keys()].sort();
	const results = ids.map((id) => {
		const entry = byId.get(id);
		if (entry === undefined) {
			throw new Error(`missing instance ${id}`);
		}
		return entry.result;
	});

	const startedAtMs = Math.min(
		...inputs.map((input) => Date.parse(input.manifest.startedAt)),
	);
	const allCompleted = inputs.every(
		(input) => input.manifest.status === "completed",
	);
	const finishedAtMs = Math.max(
		...inputs.map((input) =>
			Date.parse(input.manifest.finishedAt ?? input.manifest.startedAt),
		),
	);

	const mergedManifest: RunManifest = {
		schemaVersion: base.manifest.schemaVersion,
		runId: opts.runId,
		suite: base.manifest.suite,
		status: allCompleted ? "completed" : "running",
		startedAt: new Date(startedAtMs).toISOString(),
		...(allCompleted
			? {
					finishedAt: new Date(finishedAtMs).toISOString(),
					durationMs: Math.max(0, finishedAtMs - startedAtMs),
				}
			: {}),
		agent: base.manifest.agent,
		models: base.manifest.models,
		mainAgentTier: base.manifest.mainAgentTier,
		runtime: base.manifest.runtime,
		selection: {
			dataset: base.manifest.selection.dataset,
			split: base.manifest.selection.split,
			seed: base.manifest.selection.seed,
			limit: base.manifest.selection.limit,
			tasksetHash: base.manifest.selection.tasksetHash,
			count: ids.length,
			idsHash: hashStrings(ids),
		},
		...(base.manifest.eval === undefined ? {} : { eval: base.manifest.eval }),
	};

	// 分片的 verdict 已经是官方结果，这里只把它们并起来，不重新评测
	const resolved = results.filter((r) => r.passed).map((r) => r.instanceId);
	const unresolved = results.filter((r) => !r.passed).map((r) => r.instanceId);
	const emptyPatch = ids.filter((id) => (byId.get(id)?.patch ?? "") === "");

	const report = buildReport(
		results,
		{ runId: opts.runId, resolved, unresolved, emptyPatch },
		{
			suite: base.manifest.suite,
			dataset: base.manifest.selection.dataset,
			split: base.manifest.selection.split,
			manifest: mergedManifest,
		},
	);
	const predictions = results.map((result) => ({
		instanceId: result.instanceId,
		patch: byId.get(result.instanceId)?.patch ?? "",
	}));
	return { report, predictions };
}

export interface MergeRunDirsResult {
	paths: { jsonPath: string; markdownPath: string };
	report: BenchmarkReport;
	inputs: RunArtifacts[];
}

export async function mergeRunDirs(
	dirs: readonly string[],
	options: { outputDir: string; runId: string },
): Promise<MergeRunDirsResult> {
	if (dirs.length === 0) {
		throw new Error("merge 至少需要一个输入目录");
	}
	const inputs: RunArtifacts[] = [];
	for (const dir of dirs) {
		inputs.push(await readRunArtifacts(dir));
	}
	const { report, predictions } = mergeArtifacts(inputs, {
		runId: options.runId,
	});
	await mkdir(options.outputDir, { recursive: true });
	await writePredictions(
		join(options.outputDir, PREDICTIONS_FILE),
		predictions,
	);
	const paths = await writeReport(report, options.outputDir);
	return { paths, report, inputs };
}
