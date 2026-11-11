// 报告聚合与落盘：只保留 instance id、通过/失败、token、时长与脱敏后的失败原因。
// 明确不写 prompt、回复、diff、文件路径：失败原因先经 @hotpot/telemetry 的
// sanitizeErrorMessage 归一化（绝对路径/URL/邮箱变占位符），再截断。
// 有官方 report 时，通过与否以官方 resolved 列表为准；runner 自己的 passed 仅作参考。
//
// 指标口径：
// - 同时给 mean / median / p90。Lite300 的均值被单题 2445 万 input token 抬高 20%，
//   只看均值会让成本结论失真，中位数与 p90 才是稳定的比较口径。
// - token 按 tier 切开：main/worker/task 用不同档位，合并成一个总数就看不出钱花在哪。
// - 报告内嵌 manifest：没有实验条件的结果不能参与比较，两者必须一起走。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeErrorMessage } from "@hotpot/telemetry";
import { type BenchmarkFailureClass, classifyFailure } from "./failure.ts";
import type { BenchmarkSuite, RunManifest } from "./manifest.ts";
import type { OfficialReport } from "./swebench/evaluate.ts";
import {
	createTierTokens,
	mergeTierTokens,
	type TierTokens,
} from "./tokens.ts";

const FAILURE_REASON_MAX_CHARS = 300;

export interface InstanceResult {
	instanceId: string;
	passed: boolean;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	// 缺省表示该题没有分档位数据（旧结果/自定义 runner），聚合时按 missing 计
	tokensByTier?: TierTokens;
	// agent 轮的结局；自建题 runner 不产出，缺省时由失败文本推断
	agentOutcome?: "success" | "error" | "aborted";
	// 由 classifyFailure 统一判定，报告与遥测共用
	failureClass?: BenchmarkFailureClass;
	error?: string;
}

// 一轮跑批的远端投递结果：写进 report.json，跑批"上报了多少条"必须可查，
// 否则限流/断网导致的丢数会完全静默。
export interface TelemetryDelivery {
	enabled: boolean;
	events: number;
	sent: number;
	failed: number;
	batches: number;
	dropped: number;
}

export interface ReportFailure {
	instanceId: string;
	reason: string;
}

// nearest-rank 分位数 + 独立的中位数定义；空集合全部记 0，不产生 NaN
export interface NumericStat {
	mean: number;
	median: number;
	p90: number;
	total: number;
}

export interface TokenAggregate {
	input: NumericStat;
	output: NumericStat;
	byTier: TierTokens;
	// 有分档位数据的题数 / 总题数：小于 1 时 byTier 只是下界
	tierCoverage: number;
}

export interface BenchmarkReport {
	suite: BenchmarkSuite;
	dataset?: string;
	split?: string;
	runId?: string;
	generatedAt: string;
	// 实验条件；报告与清单一起落盘，缺一不可比
	manifest: RunManifest;
	// 由 manifest.runtime 推导，不单独赋值
	patchOnly: boolean;
	total: number;
	passed: number;
	passRate: number;
	tokens: TokenAggregate;
	durationMs: NumericStat;
	// 每个「通过题」平均消耗的 token（input + output）；无通过题时为 null，不伪装成 0
	tokensPerResolved: number | null;
	// 本轮上报到远端的结果；遥测关闭时整个字段缺省
	telemetry?: TelemetryDelivery;
	instances: InstanceResult[];
	failures: ReportFailure[];
}

export interface BuildReportOptions {
	suite: BenchmarkSuite;
	dataset?: string;
	split?: string;
	manifest: RunManifest;
}

export interface ReportPaths {
	jsonPath: string;
	markdownPath: string;
}

export function buildReport(
	results: InstanceResult[],
	official: OfficialReport | undefined,
	opts: BuildReportOptions,
): BenchmarkReport {
	const resolved = new Set(official?.resolved ?? []);
	const emptyPatches = new Set(official?.emptyPatch ?? []);
	const instances = results.map((result) => {
		const passed =
			official === undefined ? result.passed : resolved.has(result.instanceId);
		const reason = passed
			? undefined
			: sanitizeReason(
					result.error ??
						(official === undefined
							? "failed"
							: emptyPatches.has(result.instanceId)
								? "empty patch"
								: "unresolved by official harness"),
				);
		// 分类只依赖「官方结论 / agent 结局 / 失败文本」，与 reason 用同一份输入，
		// 保证 report.json 里的 failureClass 和上报到服务端的完全一致
		const failureClass = classifyFailure({
			passed,
			agentOutcome: result.agentOutcome,
			reason,
			emptyPatch: emptyPatches.has(result.instanceId),
		});
		return {
			...result,
			passed,
			...(reason === undefined ? {} : { error: reason }),
			...(failureClass === undefined ? {} : { failureClass }),
		};
	});

	const total = instances.length;
	const passed = instances.filter((instance) => instance.passed).length;
	const failures = instances
		.filter((instance) => !instance.passed)
		.map((instance) => ({
			instanceId: instance.instanceId,
			reason: instance.error ?? "failed",
		}));

	const input = numericStat(instances.map((instance) => instance.inputTokens));
	const output = numericStat(
		instances.map((instance) => instance.outputTokens),
	);
	const withTier = instances.filter(
		(instance) => instance.tokensByTier !== undefined,
	);
	const byTier = createTierTokens();
	for (const instance of withTier) {
		mergeTierTokens(byTier, instance.tokensByTier);
	}

	return {
		suite: opts.suite,
		...(opts.dataset === undefined ? {} : { dataset: opts.dataset }),
		...(opts.split === undefined ? {} : { split: opts.split }),
		...(official === undefined ? {} : { runId: official.runId }),
		generatedAt: new Date().toISOString(),
		manifest: opts.manifest,
		patchOnly: opts.manifest.runtime.patchOnly,
		total,
		passed,
		passRate: total === 0 ? 0 : passed / total,
		tokens: {
			input,
			output,
			byTier,
			tierCoverage: total === 0 ? 0 : withTier.length / total,
		},
		durationMs: numericStat(instances.map((instance) => instance.durationMs)),
		tokensPerResolved:
			passed === 0 ? null : (input.total + output.total) / passed,
		instances,
		failures,
	};
}

export async function writeReport(
	report: BenchmarkReport,
	outputDir: string,
): Promise<ReportPaths> {
	await mkdir(outputDir, { recursive: true });
	const jsonPath = join(outputDir, "report.json");
	const markdownPath = join(outputDir, "report.md");
	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	await writeFile(markdownPath, renderReportMarkdown(report));
	return { jsonPath, markdownPath };
}

export function renderReportMarkdown(report: BenchmarkReport): string {
	const manifest = report.manifest;
	const lines = [
		"# Benchmark report",
		"",
		"## Run",
		"",
		`- suite: ${report.suite}`,
		...(report.dataset === undefined ? [] : [`- dataset: ${report.dataset}`]),
		...(report.split === undefined ? [] : [`- split: ${report.split}`]),
		`- run id: ${report.runId ?? manifest.runId}`,
		`- generated at: ${report.generatedAt}`,
		`- status: ${manifest.status}`,
		`- git commit: ${formatCommit(manifest)}`,
		`- agent package: ${manifest.agent.packageVersion}`,
		`- node / platform: ${manifest.agent.node} / ${manifest.agent.platform}`,
		`- main agent tier: ${manifest.mainAgentTier}`,
		`- models: ${formatModels(manifest)}`,
		`- runtime profile: ${manifest.runtime.label} (${formatRuntime(manifest)})`,
		`- selected instances: ${manifest.selection.count} (ids sha256 ${shortHash(manifest.selection.idsHash)})`,
		...(manifest.selection.tasksetHash === undefined
			? []
			: [`- task set sha256: ${shortHash(manifest.selection.tasksetHash)}`]),
		...(manifest.eval === undefined
			? []
			: [
					`- evaluation: ${manifest.eval.mode}, max workers ${manifest.eval.maxWorkers}`,
				]),
		`- patch-only baseline: ${report.patchOnly ? "yes (the agent only edits files; it does not install dependencies or run repository tests)" : "no"}`,
		...(report.telemetry === undefined
			? []
			: [
					`- telemetry: ${report.telemetry.enabled ? `${report.telemetry.sent}/${report.telemetry.events} events delivered in ${report.telemetry.batches} batch(es)${report.telemetry.failed > 0 ? `, ${report.telemetry.failed} failed` : ""}` : "disabled"}`,
				]),
		"",
		"## Results",
		"",
		`- total: ${report.total}`,
		`- passed: ${report.passed}`,
		`- pass rate: ${(report.passRate * 100).toFixed(1)}%`,
		`- tokens per resolved instance: ${report.tokensPerResolved === null ? "n/a (no resolved instance)" : report.tokensPerResolved.toFixed(1)}`,
		"",
		"| metric | mean | median | p90 | total |",
		"|---|---|---|---|---|",
		`| input tokens | ${report.tokens.input.mean.toFixed(1)} | ${report.tokens.input.median.toFixed(1)} | ${report.tokens.input.p90.toFixed(1)} | ${report.tokens.input.total} |`,
		`| output tokens | ${report.tokens.output.mean.toFixed(1)} | ${report.tokens.output.median.toFixed(1)} | ${report.tokens.output.p90.toFixed(1)} | ${report.tokens.output.total} |`,
		`| duration (ms) | ${report.durationMs.mean.toFixed(1)} | ${report.durationMs.median.toFixed(1)} | ${report.durationMs.p90.toFixed(1)} | ${report.durationMs.total} |`,
		"",
		`Tokens by tier (coverage ${(report.tokens.tierCoverage * 100).toFixed(0)}% of instances):`,
		"",
		"| tier | input tokens | output tokens |",
		"|---|---|---|",
	];
	for (const tier of ["high", "medium", "low"] as const) {
		lines.push(
			`| ${tier} | ${report.tokens.byTier[tier].input} | ${report.tokens.byTier[tier].output} |`,
		);
	}
	lines.push("", "## Failures", "");
	if (report.failures.length === 0) {
		lines.push("None.");
	} else {
		lines.push(`By class: ${formatFailureClassCounts(report.instances)}`, "");
		for (const failure of report.failures) {
			lines.push(
				`- \`${failure.instanceId}\`: ${escapeTableCell(failure.reason)}`,
			);
		}
	}
	lines.push("", "## Instances", "");
	lines.push(
		"| instance | result | class | input tokens | output tokens | duration (ms) | failure |",
		"|---|---|---|---|---|---|---|",
	);
	for (const instance of report.instances) {
		lines.push(
			`| \`${instance.instanceId}\` | ${instance.passed ? "pass" : "fail"} | ${instance.failureClass ?? ""} | ${instance.inputTokens} | ${instance.outputTokens} | ${instance.durationMs} | ${escapeTableCell(instance.error ?? "")} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

function formatCommit(manifest: RunManifest): string {
	const { commit, dirty } = manifest.agent.git;
	if (commit === null) {
		return "unknown (not a git checkout)";
	}
	return `${commit}${dirty === true ? " (dirty)" : dirty === false ? " (clean)" : ""}`;
}

function formatModels(manifest: RunManifest): string {
	return (["high", "medium", "low"] as const)
		.map((tier) => {
			const model = manifest.models[tier];
			const endpoint =
				model.baseUrlHost === null
					? "default endpoint"
					: `${model.baseUrlHost}${model.baseUrlPath ?? ""}`;
			return `${tier}=${model.provider}/${model.model}@${endpoint}`;
		})
		.join(", ");
}

function formatRuntime(manifest: RunManifest): string {
	const runtime = manifest.runtime;
	const disabled = Object.entries(runtime.features)
		.filter(([, enabled]) => !enabled)
		.map(([name]) => name);
	const features =
		disabled.length === 0 ? "all features on" : `off: ${disabled.join("/")}`;
	return `maxParallelTasks=${runtime.maxParallelTasks}, plan auto-approve, permission=${runtime.permission}, timeout=${runtime.timeoutMs}ms, ${features}`;
}

function shortHash(hash: string): string {
	return hash.slice(0, 12);
}

// 失败分类计数是排期的直接输入：132 题失败里 aborted 43 / max_tokens 26
// 指向循环控制，unresolved 指向能力——这张计数表一眼能看出来
function formatFailureClassCounts(instances: InstanceResult[]): string {
	const counts = new Map<string, number>();
	for (const instance of instances) {
		if (instance.failureClass === undefined) {
			continue;
		}
		counts.set(
			instance.failureClass,
			(counts.get(instance.failureClass) ?? 0) + 1,
		);
	}
	if (counts.size === 0) {
		return "none";
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, count]) => `${name} ${count}`)
		.join(" / ");
}

function numericStat(values: number[]): NumericStat {
	if (values.length === 0) {
		return { mean: 0, median: 0, p90: 0, total: 0 };
	}
	const sorted = [...values].sort((a, b) => a - b);
	const total = values.reduce((sum, value) => sum + value, 0);
	return {
		mean: total / values.length,
		median: median(sorted),
		p90: nearestRank(sorted, 0.9),
		total,
	};
}

// 中位数：偶数个取中间两个的均值（nearest-rank 会偏向低值，不适合中位数）
function median(sorted: number[]): number {
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[mid] ?? 0;
	}
	const lower = sorted[mid - 1] ?? 0;
	const upper = sorted[mid] ?? 0;
	return (lower + upper) / 2;
}

function nearestRank(sorted: number[], p: number): number {
	const rank = Math.ceil(p * sorted.length) - 1;
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

function sanitizeReason(reason: string): string {
	const sanitized = sanitizeErrorMessage(reason).trim();
	if (sanitized === "") {
		return "failed";
	}
	return sanitized.length > FAILURE_REASON_MAX_CHARS
		? `${sanitized.slice(0, FAILURE_REASON_MAX_CHARS)}...`
		: sanitized;
}

function escapeTableCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}
