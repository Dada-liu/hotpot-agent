// 报告聚合与落盘：只保留 instance id、通过/失败、token、时长与脱敏后的失败原因。
// 明确不写 prompt、回复、diff、文件路径：失败原因先经 @hotpot/telemetry 的
// sanitizeErrorMessage 归一化（绝对路径/URL/邮箱变占位符），再截断。
// 有官方 report 时，通过与否以官方 resolved 列表为准；runner 自己的 passed 仅作参考。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeErrorMessage } from "@hotpot/telemetry";
import type { OfficialReport } from "./swebench/evaluate.ts";

const FAILURE_REASON_MAX_CHARS = 300;

export type BenchmarkSuite = "swebench" | "custom";

export interface InstanceResult {
	instanceId: string;
	passed: boolean;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	error?: string;
}

export interface ReportFailure {
	instanceId: string;
	reason: string;
}

export interface BenchmarkReport {
	suite: BenchmarkSuite;
	dataset?: string;
	split?: string;
	runId?: string;
	generatedAt: string;
	// M5 基线：agent 只改文件，不装依赖、不跑仓库测试
	patchOnly: boolean;
	total: number;
	passed: number;
	passRate: number;
	avgInputTokens: number;
	avgOutputTokens: number;
	avgDurationMs: number;
	instances: InstanceResult[];
	failures: ReportFailure[];
}

export interface BuildReportOptions {
	suite: BenchmarkSuite;
	dataset?: string;
	split?: string;
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
		return {
			...result,
			passed,
			...(reason === undefined ? {} : { error: reason }),
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

	return {
		suite: opts.suite,
		...(opts.dataset === undefined ? {} : { dataset: opts.dataset }),
		...(opts.split === undefined ? {} : { split: opts.split }),
		...(official === undefined ? {} : { runId: official.runId }),
		generatedAt: new Date().toISOString(),
		patchOnly: true,
		total,
		passed,
		passRate: total === 0 ? 0 : passed / total,
		avgInputTokens: average(instances.map((instance) => instance.inputTokens)),
		avgOutputTokens: average(
			instances.map((instance) => instance.outputTokens),
		),
		avgDurationMs: average(instances.map((instance) => instance.durationMs)),
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
	const lines = [
		"# Benchmark report",
		"",
		`- suite: ${report.suite}`,
		...(report.dataset === undefined ? [] : [`- dataset: ${report.dataset}`]),
		...(report.split === undefined ? [] : [`- split: ${report.split}`]),
		...(report.runId === undefined ? [] : [`- run id: ${report.runId}`]),
		`- generated at: ${report.generatedAt}`,
		"- patch-only baseline: yes (the agent only edits files; it does not install dependencies or run repository tests)",
		`- total: ${report.total}`,
		`- passed: ${report.passed}`,
		`- pass rate: ${(report.passRate * 100).toFixed(1)}%`,
		`- average input tokens: ${report.avgInputTokens.toFixed(1)}`,
		`- average output tokens: ${report.avgOutputTokens.toFixed(1)}`,
		`- average duration: ${report.avgDurationMs.toFixed(1)} ms`,
		"",
		"## Failures",
		"",
	];
	if (report.failures.length === 0) {
		lines.push("None.");
	} else {
		for (const failure of report.failures) {
			lines.push(
				`- \`${failure.instanceId}\`: ${escapeTableCell(failure.reason)}`,
			);
		}
	}
	lines.push("", "## Instances", "");
	lines.push(
		"| instance | result | input tokens | output tokens | duration (ms) | failure |",
		"|---|---|---|---|---|---|",
	);
	for (const instance of report.instances) {
		lines.push(
			`| \`${instance.instanceId}\` | ${instance.passed ? "pass" : "fail"} | ${instance.inputTokens} | ${instance.outputTokens} | ${instance.durationMs} | ${escapeTableCell(instance.error ?? "")} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
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

function average(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}
