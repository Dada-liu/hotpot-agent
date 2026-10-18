// 官方评测编排测试：只覆盖命令构造与 report 解析，不执行 Python / Docker / SSH。
// report 解析同时兼容官方 harness 的 resolved_ids/unresolved_ids/empty_patch_ids
// 与更早/更晚版本的 resolved/unresolved 数组命名。

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildEvaluationCommand,
	parseOfficialReport,
} from "../src/swebench/evaluate.ts";

const REPORT_FIXTURE = join(
	process.cwd(),
	"packages/benchmarks/test/fixtures/official-report.json",
);

describe("buildEvaluationCommand", () => {
	it("构造官方 run_evaluation 的 argv", () => {
		const argv = buildEvaluationCommand({
			dataset: "princeton-nlp/SWE-bench_Lite",
			split: "test",
			predictionsPath: "/runs/1/predictions.jsonl",
			maxWorkers: 1,
			runId: "run-1",
			reportDir: "/runs/1/report",
		});
		expect(argv).toEqual([
			"python3",
			"-m",
			"swebench.harness.run_evaluation",
			"--dataset_name",
			"princeton-nlp/SWE-bench_Lite",
			"--split",
			"test",
			"--predictions_path",
			"/runs/1/predictions.jsonl",
			"--max_workers",
			"1",
			"--run_id",
			"run-1",
			"--report_dir",
			"/runs/1/report",
		]);
	});
});

describe("parseOfficialReport", () => {
	it("解析 resolved / unresolved / empty patch 列表与 run id", async () => {
		const report = await parseOfficialReport(REPORT_FIXTURE);
		expect(report.runId).toBe("run-1");
		expect(report.resolved).toEqual([
			"django__django-11099",
			"pytest-dev__pytest-7432",
		]);
		expect(report.unresolved).toEqual([
			"sympy__sympy-20590",
			"matplotlib__matplotlib-22835",
		]);
		expect(report.emptyPatch).toEqual(["matplotlib__matplotlib-22835"]);
	});
});
