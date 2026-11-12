// 报告聚合测试：通过率、均值/中位数/p90、分档位 token、失败列表与官方 report 的合并，
// 以及失败原因脱敏（报告只允许 instance id、指标与脱敏原因，不含 prompt/patch）。
// 报告同时内嵌运行清单：没有实验条件的结果不构成可比较的结论。

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
import { BENCHMARK_RUNTIME } from "../src/runtime-profile.ts";
import { addTierUsage, createTierTokens } from "../src/tokens.ts";
import { makeManifest } from "./helpers/manifest.ts";

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
	it("统计通过率、均值/中位数/p90 与失败原因", () => {
		const report = buildReport(
			[
				result({
					instanceId: "a",
					passed: true,
					inputTokens: 10,
					outputTokens: 2,
				}),
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
				result({
					instanceId: "d",
					passed: true,
					inputTokens: 100,
					outputTokens: 10,
					durationMs: 1000,
				}),
			],
			undefined,
			{ suite: "custom", manifest: makeManifest() },
		);

		expect(report.total).toBe(4);
		expect(report.passed).toBe(3);
		expect(report.passRate).toBeCloseTo(3 / 4);
		// 均值被 100 拉高，中位数与 p90 给出未被单题带偏的口径
		expect(report.tokens.input.mean).toBe(40);
		expect(report.tokens.input.median).toBe(25);
		expect(report.tokens.input.p90).toBe(100);
		expect(report.tokens.input.total).toBe(160);
		expect(report.tokens.output.mean).toBe(5.5);
		expect(report.durationMs.median).toBe(250);
		// 每个通过题平均消耗 (160 + 22) / 3
		expect(report.tokensPerResolved).toBeCloseTo(182 / 3);
		expect(report.failures).toEqual([
			{ instanceId: "c", reason: "git worktree add failed" },
		]);
	});

	it("有官方 report 时以官方 resolved 为准，patchOnly 来自运行清单", () => {
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
				dataset: "SWE-bench/SWE-bench_Lite",
				split: "test",
				manifest: makeManifest({ suite: "swebench" }),
			},
		);

		expect(report.passed).toBe(1);
		expect(report.instances.map((instance) => instance.passed)).toEqual([
			true,
			false,
		]);
		expect(report.failures).toEqual([
			{ instanceId: "b", reason: "empty patch" },
		]);
		expect(report.runId).toBe("run-1");
		expect(report.patchOnly).toBe(true);
	});

	it("patchOnly 跟随运行档，而不是写死", () => {
		const report = buildReport([result({ instanceId: "a" })], undefined, {
			suite: "custom",
			manifest: makeManifest({
				runtime: {
					...BENCHMARK_RUNTIME,
					label: "full-agent",
					patchOnly: false,
				},
			}),
		});
		expect(report.patchOnly).toBe(false);
		expect(report.manifest.runtime.label).toBe("full-agent");
	});

	it("token 按档位聚合，并给出档位覆盖率", () => {
		const highLow = createTierTokens();
		addTierUsage(highLow, "high", { input: 5, output: 1 });
		addTierUsage(highLow, "low", { input: 3, output: 2 });
		const report = buildReport(
			[
				result({ instanceId: "a", tokensByTier: highLow }),
				result({ instanceId: "b" }),
			],
			undefined,
			{ suite: "custom", manifest: makeManifest() },
		);

		expect(report.tokens.byTier.high).toEqual({ input: 5, output: 1 });
		expect(report.tokens.byTier.low).toEqual({ input: 3, output: 2 });
		expect(report.tokens.byTier.medium).toEqual({ input: 0, output: 0 });
		// 只有一题带分档位数据：byTier 是下界，必须能被看出来
		expect(report.tokens.tierCoverage).toBe(0.5);
	});

	it("没有通过题时 tokensPerResolved 为 null", () => {
		const report = buildReport(
			[result({ instanceId: "a", passed: false })],
			undefined,
			{ suite: "custom", manifest: makeManifest() },
		);
		expect(report.tokensPerResolved).toBeNull();
	});

	it("多次尝试：每题保留每次结果，并给出每轮通过率与波动", () => {
		// a 在 3 次里通过 2 次，b 全通过 → 每轮 100% / 100% / 50%
		const results: InstanceResult[] = [
			result({ instanceId: "a", attempt: 1, passed: true }),
			result({ instanceId: "b", attempt: 1, passed: true }),
			result({ instanceId: "a", attempt: 2, passed: true }),
			result({ instanceId: "b", attempt: 2, passed: true }),
			result({
				instanceId: "a",
				attempt: 3,
				passed: false,
				error: "unresolved",
			}),
			result({ instanceId: "b", attempt: 3, passed: true }),
		];
		const report = buildReport(results, undefined, {
			suite: "swebench",
			manifest: makeManifest({ suite: "swebench" }),
		});

		// total 是题目数，passed 是通过的尝试次数
		expect(report.total).toBe(2);
		expect(report.instances).toHaveLength(6);
		expect(report.passed).toBe(5);
		expect(report.passRate).toBeCloseTo(5 / 6);
		// 「至少通过一次」单独给出，避免把 5/6 读成「每题都通过」
		expect(report.resolvedInstances).toBe(2);

		expect(report.repeat.attempts).toBe(3);
		expect(report.repeat.passRateByAttempt).toEqual([1, 1, 0.5]);
		expect(report.repeat.passRateMin).toBe(0.5);
		expect(report.repeat.passRateMax).toBe(1);
		expect(report.repeat.passRateMean).toBeCloseTo(5 / 6);
		// 样本标准差（n-1）：sqrt(((1/6)^2 × 2 + (1/3)^2) / 2)
		expect(report.repeat.passRateStdDev).toBeCloseTo(Math.sqrt(1 / 12));

		const summaryA = report.perInstance.find((item) => item.instanceId === "a");
		expect(summaryA).toMatchObject({
			attempts: 3,
			passed: 2,
			flaky: true,
		});
		expect(summaryA?.passRate).toBeCloseTo(2 / 3);
		// b 三次全过：不是 flaky
		expect(
			report.perInstance.find((item) => item.instanceId === "b"),
		).toMatchObject({
			flaky: false,
		});
		expect(report.repeat.flakyInstances).toBe(1);
		// 只列「一次都没通过」的题：a 通过过两次，不进失败列表
		expect(report.failures).toEqual([]);
	});

	it("多次尝试：官方 verdict 按 attempt 对齐", () => {
		const results = [
			result({ instanceId: "a", attempt: 1, passed: true }),
			result({ instanceId: "a", attempt: 2, passed: true }),
		];
		// 第 1 次官方判定通过，第 2 次判定不通过：以官方为准，而不是 runner 的 passed
		const report = buildReport(
			results,
			[
				{ runId: "run-a1", resolved: ["a"], unresolved: [], emptyPatch: [] },
				{ runId: "run-a2", resolved: [], unresolved: ["a"], emptyPatch: [] },
			],
			{ suite: "swebench", manifest: makeManifest({ suite: "swebench" }) },
		);
		expect(report.passed).toBe(1);
		expect(report.perInstance[0]).toMatchObject({
			instanceId: "a",
			attempts: 2,
			passed: 1,
			flaky: true,
		});
		expect(report.failures).toEqual([]);
		// 失败列表只装「一次都没通过」的题；a 的失败体现在 perInstance.flaky 与逐尝试明细里
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
			{ suite: "custom", manifest: makeManifest() },
		);
		const reason = report.failures[0]?.reason ?? "";
		expect(reason).not.toContain("/Users/alice");
		expect(reason).toContain("<path>");
	});
});

describe("writeReport", () => {
	it("写出 report.json 与 report.md，含运行清单且不含任何 diff 内容", async () => {
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
				dataset: "SWE-bench/SWE-bench_Lite",
				split: "test",
				manifest: makeManifest({
					suite: "swebench",
					selection: { count: 2, idsHash: "0123456789abcdef" },
				}),
			},
		);
		const paths = await writeReport(report, dir);
		const json = await readFile(paths.jsonPath, "utf8");
		const markdown = await readFile(paths.markdownPath, "utf8");
		expect(json).toContain("django__django-11099");
		expect(json).toContain('"manifest"');
		expect(markdown).toContain("pass rate");
		expect(markdown).toContain("patch-only");
		expect(markdown).toContain("empty patch");
		expect(markdown).toContain("git commit: deadbeef (clean)");
		expect(markdown).toContain("ids sha256 0123456789ab");
		expect(markdown).toContain("Tokens by tier");
		expect(markdown).not.toContain("diff --git");
	});
});
