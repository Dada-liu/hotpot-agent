// 报告聚合测试：通过率、平均 token/时长、失败列表与官方 report 的合并，
// 以及失败原因脱敏（报告只允许 instance id、指标与脱敏原因，不含 prompt/patch）。

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildReport,
	type InstanceResult,
	type OfficialReport,
	writeReport,
} from "../src/index.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-bench-report-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function result(overrides: Partial<InstanceResult>): InstanceResult {
	return {
		instanceId: "instance",
		passed: true,
		durationMs: 100,
		inputTokens: 10,
		outputTokens: 2,
		...overrides,
	};
}

describe("buildReport", () => {
	it("统计通过率与平均值，保留失败原因", () => {
		const report = buildReport(
			[
				result({ instanceId: "a", passed: true }),
				result({
					instanceId: "b",
					passed: true,
					inputTokens: 20,
					outputTokens: 4,
					durationMs: 200,
				}),
				result({
					instanceId: "c",
					passed: false,
					inputTokens: 30,
					outputTokens: 6,
					durationMs: 300,
					error: "git worktree add failed",
				}),
			],
			undefined,
			{ suite: "custom" },
		);

		expect(report.total).toBe(3);
		expect(report.passed).toBe(2);
		expect(report.passRate).toBeCloseTo(2 / 3);
		expect(report.avgInputTokens).toBe(20);
		expect(report.avgOutputTokens).toBe(4);
		expect(report.avgDurationMs).toBe(200);
		expect(report.failures).toEqual([
			{ instanceId: "c", reason: "git worktree add failed" },
		]);
	});

	it("有官方 report 时以官方 resolved 为准", () => {
		const official: OfficialReport = {
			runId: "run-1",
			resolved: ["a"],
			unresolved: ["b"],
			emptyPatch: ["b"],
		};
		const report = buildReport(
			[
				result({ instanceId: "a", passed: false, error: "agent timeout" }),
				result({ instanceId: "b", passed: true }),
			],
			official,
			{
				suite: "swebench",
				dataset: "princeton-nlp/SWE-bench_Lite",
				split: "test",
			},
		);

		expect(report.passed).toBe(1);
		expect(report.instances.map((instance) => instance.passed)).toEqual([
			true,
			false,
		]);
		expect(report.failures).toEqual([
			{ instanceId: "b", reason: "unresolved by official harness" },
		]);
		expect(report.runId).toBe("run-1");
		expect(report.patchOnly).toBe(true);
	});

	it("失败原因中的绝对路径被脱敏", () => {
		const report = buildReport(
			[
				result({
					instanceId: "a",
					passed: false,
					error: "clone failed at /Users/alice/private/repo.git",
				}),
			],
			undefined,
			{ suite: "custom" },
		);
		const reason = report.failures[0]?.reason ?? "";
		expect(reason).not.toContain("/Users/alice");
		expect(reason).toContain("<path>");
	});
});

describe("writeReport", () => {
	it("写出 report.json 与 report.md，且不包含任何 diff 内容", async () => {
		const report = buildReport(
			[
				result({ instanceId: "django__django-11099", passed: true }),
				result({
					instanceId: "pytest-dev__pytest-7432",
					passed: false,
					error: "empty patch",
				}),
			],
			undefined,
			{
				suite: "swebench",
				dataset: "princeton-nlp/SWE-bench_Lite",
				split: "test",
			},
		);
		const paths = await writeReport(report, dir);
		const json = await readFile(paths.jsonPath, "utf8");
		const markdown = await readFile(paths.markdownPath, "utf8");
		expect(json).toContain("django__django-11099");
		expect(markdown).toContain("pass rate");
		expect(markdown).toContain("patch-only");
		expect(markdown).toContain("empty patch");
		expect(markdown).not.toContain("diff --git");
	});
});
