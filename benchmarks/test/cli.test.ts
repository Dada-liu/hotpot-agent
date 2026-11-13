// CLI 参数解析测试：不触发真实跑批（不读 settings、不建 worktree）。
// 断言默认值、显式值、--help 以及未知参数/非法枚举的报错。

import { describe, expect, it } from "vitest";
import { patchEntries } from "../src/cli.ts";
import { BENCH_USAGE, parseBenchArgs } from "../src/cli-args.ts";
import type { SwebenchInstance } from "../src/swebench/instances.ts";

function instance(instanceId: string): SwebenchInstance {
	return {
		instance_id: instanceId,
		repo: "test/repo",
		base_commit: "abc",
		problem_statement: "x",
		FAIL_TO_PASS: [],
		PASS_TO_PASS: [],
		version: "1",
	};
}

describe("parseBenchArgs", () => {
	it("--help 返回 help，用法包含两个 suite", () => {
		expect(parseBenchArgs(["--help"])).toEqual({ suite: "help" });
		expect(BENCH_USAGE).toContain("swebench");
		expect(BENCH_USAGE).toContain("custom");
	});

	it("swebench 默认值与显式参数", () => {
		const defaults = parseBenchArgs(["swebench"]);
		expect(defaults).toMatchObject({
			suite: "swebench",
			instancesFile: "instances.jsonl",
			suiteName: "lite10",
			dataset: "SWE-bench/SWE-bench_Lite",
			split: "test",
			seed: 0,
			evalMode: "local",
			evalHost: "macmini",
			maxWorkers: 1,
		});

		const explicit = parseBenchArgs([
			"swebench",
			"--limit",
			"2",
			"--instance-ids",
			"a__a-1,b__b-2",
			"--instances-file",
			"instances.jsonl",
			"--eval-mode",
			"remote",
			"--eval-host",
			"host",
			"--max-workers",
			"3",
			"--model-tier",
			"low",
		]);
		expect(explicit).toMatchObject({
			suite: "swebench",
			limit: 2,
			instanceIds: ["a__a-1", "b__b-2"],
			evalMode: "remote",
			evalHost: "host",
			maxWorkers: 3,
			modelTier: "low",
		});
	});

	it("--suite 显式指定固定 id 套件", () => {
		expect(parseBenchArgs(["swebench", "--suite", "dev100"])).toMatchObject({
			suiteName: "dev100",
		});
		expect(() => parseBenchArgs(["swebench", "--suite"])).toThrow(
			/requires a value/,
		);
	});

	it("custom 支持 --domain", () => {
		expect(parseBenchArgs(["custom", "--domain", "finance"])).toMatchObject({
			suite: "custom",
			domain: "finance",
		});
	});

	it("swebench 支持 --shard 与 --resume", () => {
		expect(
			parseBenchArgs(["swebench", "--shard", "2/3", "--resume"]),
		).toMatchObject({
			suite: "swebench",
			shard: { index: 1, count: 3 },
			resume: true,
		});
		// 默认不续跑：--resume 必须是显式选择
		expect(parseBenchArgs(["swebench"])).toMatchObject({ resume: false });
	});

	it("swebench 默认每个实例跑 3 次，--repeat 可覆盖", () => {
		// 默认 3 次：10 题上的单次通过率方差是 ±1~2 题，不重复就分不清信号与噪声
		expect(parseBenchArgs(["swebench"])).toMatchObject({ repeat: 3 });
		expect(parseBenchArgs(["swebench", "--repeat", "5"])).toMatchObject({
			repeat: 5,
		});
		expect(() => parseBenchArgs(["swebench", "--repeat", "0"])).toThrow(
			/--repeat must be a positive integer/,
		);
		expect(() => parseBenchArgs(["swebench", "--repeat"])).toThrow(
			/--repeat requires a value/,
		);
	});

	it("merge 收集位置参数并要求 --output", () => {
		expect(
			parseBenchArgs(["merge", "runs/a", "runs/b", "--output", "runs/all"]),
		).toEqual({
			suite: "merge",
			dirs: ["runs/a", "runs/b"],
			output: "runs/all",
		});
		expect(() => parseBenchArgs(["merge", "runs/a"])).toThrow(
			/merge requires --output/,
		);
		expect(() => parseBenchArgs(["merge", "--output", "x"])).toThrow(
			/at least one run directory/,
		);
	});

	it("doctor 默认只查本地条件，--offline 关掉网络探测", () => {
		expect(parseBenchArgs(["doctor"])).toMatchObject({
			suite: "doctor",
			evalMode: "local",
			offline: false,
			instancesFile: "instances.jsonl",
		});
		expect(parseBenchArgs(["doctor", "--offline"])).toMatchObject({
			offline: true,
		});
	});

	it("未知参数与非法枚举退出非零（抛 UsageError）", () => {
		expect(() => parseBenchArgs(["swebench", "--nope"])).toThrow(
			/unknown option: --nope/,
		);
		expect(() => parseBenchArgs(["custom", "--domain", "legal"])).toThrow(
			/--domain must be one of/,
		);
		expect(() => parseBenchArgs(["swebench", "--eval-mode", "cloud"])).toThrow(
			/--eval-mode/,
		);
		expect(() => parseBenchArgs(["swebench", "--limit"])).toThrow(
			/--limit requires a value/,
		);
		expect(() => parseBenchArgs(["unknown"])).toThrow(/unknown suite/);
		expect(() => parseBenchArgs(["swebench", "--shard", "0/3"])).toThrow(
			/shard index/,
		);
		expect(() => parseBenchArgs(["swebench", "--shard", "1"])).toThrow(
			/shard must look like/,
		);
		expect(() => parseBenchArgs(["swebench", "--resume=yes"])).toThrow(
			/--resume does not take a value/,
		);
	});
});

describe("patchEntries", () => {
	it("保留空 patch：跑过但没产出 diff 的题不能被当成没跑过", () => {
		const entries = patchEntries(
			[instance("a"), instance("b")],
			2,
			new Map([["a", ""]]),
			new Map([["b#2", "diff-b"]]),
		);
		expect(entries).toEqual([
			{ instanceId: "a", attempt: 2, patch: "" },
			{ instanceId: "b", attempt: 2, patch: "diff-b" },
		]);
	});

	it("复用的 patch 只认同一尝试序号", () => {
		const entries = patchEntries(
			[instance("a")],
			2,
			new Map(),
			new Map([["a#1", "diff-a1"]]),
		);
		// 第 1 次的 patch 不能顶替第 2 次：否则 resume 会把旧结果当成新尝试
		expect(entries).toEqual([]);
	});
});
