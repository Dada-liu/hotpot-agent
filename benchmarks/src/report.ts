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

// 产物文件名做成常量：resume 与 merge 都要按名字回读，
// 三处各写一遍字面量迟早会分叉。
export const REPORT_FILE = "report.json";
export const REPORT_MARKDOWN_FILE = "report.md";

export interface InstanceResult {
	instanceId: string;
	// 1-based 尝试序号。缺省按 1 处理：旧报告、custom 套件与单次跑批都没有这个字段
	attempt?: number;
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

// 同一道题在 k 次尝试上的汇总。passRate 落在 (0, 1) 之间就是 flaky：
// 它说明「这题到底行不行」本身不稳定，任何基于单次结果的比较都不可信。
export interface InstanceSummary {
	instanceId: string;
	attempts: number;
	// 通过的尝试次数
	passed: number;
	passRate: number;
	flaky: boolean;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	// 最后一次尝试的失败原因；至少通过一次时缺省
	lastError?: string;
}

// 重复跑批的波动口径：passRateByAttempt 是「每一轮各自的通过率」，
// 它的极差就是「同一份代码自己跑 k 次能得到多大差异」的实证标尺。
// 判定改动是否有效时，差异必须超过这个极差，否则只能给 inconclusive。
export interface RepeatSummary {
	attempts: number;
	passRateByAttempt: number[];
	passRateMean: number;
	// 样本标准差（n-1）；只有一次尝试时为 0，且不构成误差棒
	passRateStdDev: number;
	passRateMin: number;
	passRateMax: number;
	flakyInstances: number;
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
	// 题目数（去重后），不是尝试数
	total: number;
	// 通过的尝试次数：k 次尝试里通过了几次
	passed: number;
	// 尝试级通过率 = passed / 尝试总数，等价于「每轮通过率」的均值
	passRate: number;
	// 至少通过一次的题目数：与 passRate 分开，避免用「至少一次」掩盖稳定性下降
	resolvedInstances: number;
	tokens: TokenAggregate;
	durationMs: NumericStat;
	// 每次「通过」平均消耗的 token（input + output）；无通过时为 null，不伪装成 0
	tokensPerResolved: number | null;
	// 同一 runId 下的重复尝试与波动；attempts=1 表示没有误差棒
	repeat: RepeatSummary;
	// 本轮上报到远端的结果；遥测关闭时整个字段缺省
	telemetry?: TelemetryDelivery;
	// 每条对应一次尝试（instance × attempt）
	instances: InstanceResult[];
	// 每道题的跨尝试汇总
	perInstance: InstanceSummary[];
	// 只列「一次都没通过」的题；失败原因取最后一次尝试
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
	official:
		| OfficialReport
		| readonly (OfficialReport | undefined)[]
		| undefined,
	opts: BuildReportOptions,
): BenchmarkReport {
	// 单份 official 等价于「只有第 1 次尝试」；数组用于 repeat>1 时按 attempt 对齐
	const officials = normalizeOfficials(official);
	const resolvedByAttempt = officials.map(
		(report) => new Set(report?.resolved ?? []),
	);
	const emptyPatchByAttempt = officials.map(
		(report) => new Set(report?.emptyPatch ?? []),
	);

	const instances = results.map((result) => {
		const attempt = result.attempt ?? 1;
		const attemptIndex = attempt - 1;
		const officialForAttempt = officials[attemptIndex];
		const passed =
			officialForAttempt === undefined
				? result.passed
				: (resolvedByAttempt[attemptIndex]?.has(result.instanceId) ?? false);
		const officialEmptyPatch =
			emptyPatchByAttempt[attemptIndex]?.has(result.instanceId) ?? false;
		const reason = passed
			? undefined
			: sanitizeReason(
					result.error ??
						(officialForAttempt === undefined
							? "failed"
							: officialEmptyPatch
								? "empty patch"
								: "unresolved by official harness"),
				);
		// 分类只依赖「官方结论 / agent 结局 / 失败文本」，与 reason 用同一份输入，
		// 保证 report.json 里的 failureClass 和上报到服务端的完全一致
		const failureClass = classifyFailure({
			passed,
			agentOutcome: result.agentOutcome,
			reason,
			emptyPatch: officialEmptyPatch,
		});
		return {
			...result,
			attempt,
			passed,
			...(reason === undefined ? {} : { error: reason }),
			...(failureClass === undefined ? {} : { failureClass }),
		};
	});

	const perInstance = summarizePerInstance(instances);
	// total 是题目数：重复尝试不改变「考了几道题」，只改变「每题考了几次」
	const total = perInstance.length;
	// passed 是「通过的尝试次数」：passRate 因此是尝试级平均，而不是至少通过一次的比例
	const passed = instances.filter((instance) => instance.passed).length;
	const resolvedInstances = perInstance.filter(
		(instance) => instance.passed > 0,
	).length;
	const failures = perInstance
		.filter((instance) => instance.passed === 0)
		.map((instance) => ({
			instanceId: instance.instanceId,
			reason: instance.lastError ?? "failed",
		}));

	const input = numericStat(instances.map((instance) => instance.inputTokens));
	const output = numericStat(
		instances.map((instance) => instance.outputTokens),
	);
	// 重复尝试时官方会给出多份 report，取第一份非空的 runId 作为代表
	const runId = officials.find((report) => report !== undefined)?.runId;
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
		...(runId === undefined ? {} : { runId }),
		generatedAt: new Date().toISOString(),
		manifest: opts.manifest,
		patchOnly: opts.manifest.runtime.patchOnly,
		total,
		passed,
		passRate: instances.length === 0 ? 0 : passed / instances.length,
		resolvedInstances,
		tokens: {
			input,
			output,
			byTier,
			tierCoverage:
				instances.length === 0 ? 0 : withTier.length / instances.length,
		},
		durationMs: numericStat(instances.map((instance) => instance.durationMs)),
		tokensPerResolved:
			passed === 0 ? null : (input.total + output.total) / passed,
		repeat: summarizeRepeat(instances, perInstance),
		instances,
		perInstance,
		failures,
	};
}

function normalizeOfficials(
	official:
		| OfficialReport
		| readonly (OfficialReport | undefined)[]
		| undefined,
): (OfficialReport | undefined)[] {
	if (official === undefined) {
		return [];
	}
	if (Array.isArray(official)) {
		return [...official];
	}
	return [official as OfficialReport];
}

// 按题聚合。输入顺序不保证，先按 attempt 排序，保证 lastError 取的是最后一次尝试。
function summarizePerInstance(
	instances: readonly InstanceResult[],
): InstanceSummary[] {
	const ordered = [...instances].sort(
		(a, b) => (a.attempt ?? 1) - (b.attempt ?? 1),
	);
	const byId = new Map<string, InstanceSummary>();
	for (const instance of ordered) {
		const existing = byId.get(instance.instanceId);
		if (existing === undefined) {
			byId.set(instance.instanceId, {
				instanceId: instance.instanceId,
				attempts: 1,
				passed: instance.passed ? 1 : 0,
				passRate: instance.passed ? 1 : 0,
				flaky: false,
				inputTokens: instance.inputTokens,
				outputTokens: instance.outputTokens,
				durationMs: instance.durationMs,
				...(instance.passed || instance.error === undefined
					? {}
					: { lastError: instance.error }),
			});
			continue;
		}
		existing.attempts += 1;
		existing.passed += instance.passed ? 1 : 0;
		existing.inputTokens += instance.inputTokens;
		existing.outputTokens += instance.outputTokens;
		existing.durationMs += instance.durationMs;
		if (instance.passed) {
			delete existing.lastError;
		} else if (instance.error !== undefined) {
			existing.lastError = instance.error;
		}
	}
	return [...byId.values()].map((summary) => ({
		...summary,
		passRate: summary.attempts === 0 ? 0 : summary.passed / summary.attempts,
		flaky: summary.passed > 0 && summary.passed < summary.attempts,
	}));
}

function summarizeRepeat(
	instances: readonly InstanceResult[],
	perInstance: readonly InstanceSummary[],
): RepeatSummary {
	const byAttempt = new Map<number, { passed: number; total: number }>();
	for (const instance of instances) {
		const attempt = instance.attempt ?? 1;
		const bucket = byAttempt.get(attempt) ?? { passed: 0, total: 0 };
		bucket.total += 1;
		bucket.passed += instance.passed ? 1 : 0;
		byAttempt.set(attempt, bucket);
	}
	const attempts = [...byAttempt.keys()].sort((a, b) => a - b);
	const passRateByAttempt = attempts.map((attempt) => {
		const bucket = byAttempt.get(attempt);
		if (bucket === undefined || bucket.total === 0) {
			return 0;
		}
		return bucket.passed / bucket.total;
	});
	const mean = average(passRateByAttempt);
	// 样本标准差：k 次尝试是从「同一版本的运行分布」里抽的样本，
	// 用 n-1 才不会在 k=3 这种小样本上低估波动
	const variance =
		passRateByAttempt.length > 1
			? passRateByAttempt.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
				(passRateByAttempt.length - 1)
			: 0;
	return {
		attempts: passRateByAttempt.length,
		passRateByAttempt,
		passRateMean: mean,
		passRateStdDev: Math.sqrt(variance),
		passRateMin:
			passRateByAttempt.length === 0 ? 0 : Math.min(...passRateByAttempt),
		passRateMax:
			passRateByAttempt.length === 0 ? 0 : Math.max(...passRateByAttempt),
		flakyInstances: perInstance.filter((summary) => summary.flaky).length,
	};
}

function average(values: readonly number[]): number {
	if (values.length === 0) {
		return 0;
	}
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function writeReport(
	report: BenchmarkReport,
	outputDir: string,
): Promise<ReportPaths> {
	await mkdir(outputDir, { recursive: true });
	const jsonPath = join(outputDir, REPORT_FILE);
	const markdownPath = join(outputDir, REPORT_MARKDOWN_FILE);
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
		`- attempts per instance: ${report.repeat.attempts}${report.repeat.attempts > 1 ? "" : " (single attempt: no variance estimate)"}`,
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
		`- instances: ${report.total}`,
		`- attempts: ${report.instances.length}`,
		`- passed attempts: ${report.passed}`,
		`- pass rate (per attempt): ${(report.passRate * 100).toFixed(1)}%`,
		`- instances resolved at least once: ${report.resolvedInstances}/${report.total}`,
		`- tokens per resolved attempt: ${report.tokensPerResolved === null ? "n/a (no resolved attempt)" : report.tokensPerResolved.toFixed(1)}`,
		"",
		"| metric | mean | median | p90 | total |",
		"|---|---|---|---|---|",
		`| input tokens | ${report.tokens.input.mean.toFixed(1)} | ${report.tokens.input.median.toFixed(1)} | ${report.tokens.input.p90.toFixed(1)} | ${report.tokens.input.total} |`,
		`| output tokens | ${report.tokens.output.mean.toFixed(1)} | ${report.tokens.output.median.toFixed(1)} | ${report.tokens.output.p90.toFixed(1)} | ${report.tokens.output.total} |`,
		`| duration (ms) | ${report.durationMs.mean.toFixed(1)} | ${report.durationMs.median.toFixed(1)} | ${report.durationMs.p90.toFixed(1)} | ${report.durationMs.total} |`,
		"",
		`Tokens by tier (coverage ${(report.tokens.tierCoverage * 100).toFixed(0)}% of attempts):`,
		"",
		"| tier | input tokens | output tokens |",
		"|---|---|---|",
	];
	for (const tier of ["high", "medium", "low"] as const) {
		lines.push(
			`| ${tier} | ${report.tokens.byTier[tier].input} | ${report.tokens.byTier[tier].output} |`,
		);
	}
	lines.push("", "## Spread across attempts", "");
	if (report.repeat.attempts <= 1) {
		lines.push(
			"Single attempt: no variance estimate. Re-run with `--repeat 3` before drawing a conclusion from a small diff.",
		);
	} else {
		const spread = report.repeat.passRateMax - report.repeat.passRateMin;
		lines.push(
			`- pass rate per attempt: ${report.repeat.passRateByAttempt.map((rate) => `${(rate * 100).toFixed(1)}%`).join(" / ")}`,
			`- pass rate mean ± sd: ${(report.repeat.passRateMean * 100).toFixed(1)}% ± ${(report.repeat.passRateStdDev * 100).toFixed(1)}pp`,
			`- pass rate range: ${(report.repeat.passRateMin * 100).toFixed(1)}% ~ ${(report.repeat.passRateMax * 100).toFixed(1)}% (${(spread * report.total).toFixed(1)} of ${report.total} instances)`,
			`- flaky instances: ${report.repeat.flakyInstances} (pass rate strictly between 0 and 1)`,
			"",
			"A candidate version must move the pass rate beyond this range before the difference counts as real.",
		);
	}
	lines.push("", "## Failures", "");
	if (report.failures.length === 0) {
		lines.push("None.");
	} else {
		// 分类只统计「一次都没通过」的题：通过过一次但翻转过 2 次的题在 flaky 里体现，
		// 混进失败分类会把排期引向错误的方向。
		const neverPassed = new Set(
			report.failures.map((failure) => failure.instanceId),
		);
		lines.push(
			`By class: ${formatFailureClassCounts(report.instances, neverPassed)}`,
			"",
		);
		for (const failure of report.failures) {
			lines.push(
				`- \`${failure.instanceId}\`: ${escapeTableCell(failure.reason)}`,
			);
		}
	}
	lines.push("", "## Per instance", "");
	lines.push(
		"| instance | passed / attempts | pass rate | flaky | input tokens | output tokens |",
		"|---|---|---|---|---|---|",
	);
	for (const summary of report.perInstance) {
		lines.push(
			`| \`${summary.instanceId}\` | ${summary.passed}/${summary.attempts} | ${(summary.passRate * 100).toFixed(0)}% | ${summary.flaky ? "yes" : "no"} | ${summary.inputTokens} | ${summary.outputTokens} |`,
		);
	}
	lines.push("", "## Attempts", "");
	lines.push(
		"| instance | attempt | result | class | input tokens | output tokens | duration (ms) | failure |",
		"|---|---|---|---|---|---|---|---|",
	);
	// 按题再按尝试排序：同一题的 k 次结果连在一起，才看得出它在哪一次翻转
	const attemptRows = [...report.instances].sort((a, b) => {
		if (a.instanceId !== b.instanceId) {
			return a.instanceId < b.instanceId ? -1 : 1;
		}
		return (a.attempt ?? 1) - (b.attempt ?? 1);
	});
	for (const instance of attemptRows) {
		lines.push(
			`| \`${instance.instanceId}\` | ${instance.attempt ?? 1} | ${instance.passed ? "pass" : "fail"} | ${instance.failureClass ?? ""} | ${instance.inputTokens} | ${instance.outputTokens} | ${instance.durationMs} | ${escapeTableCell(instance.error ?? "")} |`,
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
// 指向循环控制，unresolved 指向能力——这张计数表一眼能看出来。
// 重复尝试时每题只算一次（取最后一次的分类），且只统计一次都没通过的题，
// 否则 k 次失败会被算成 k 道题，翻转过的题也会被误列进排期。
function formatFailureClassCounts(
	instances: InstanceResult[],
	neverPassed: ReadonlySet<string>,
): string {
	const latest = new Map<string, InstanceResult>();
	for (const instance of instances) {
		if (!neverPassed.has(instance.instanceId)) {
			continue;
		}
		const previous = latest.get(instance.instanceId);
		if (
			previous === undefined ||
			(instance.attempt ?? 1) >= (previous.attempt ?? 1)
		) {
			latest.set(instance.instanceId, instance);
		}
	}
	const counts = new Map<string, number>();
	for (const instance of latest.values()) {
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
