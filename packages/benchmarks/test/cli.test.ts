// CLI 参数解析测试：不触发真实跑批（不读 settings、不建 worktree）。
// 断言默认值、显式值、--help 以及未知参数/非法枚举的报错。

import { describe, expect, it } from "vitest";
import { BENCH_USAGE, parseBenchArgs } from "../src/cli-args.ts";

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
			dataset: "princeton-nlp/SWE-bench_Lite",
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

	it("custom 支持 --domain", () => {
		expect(parseBenchArgs(["custom", "--domain", "finance"])).toMatchObject({
			suite: "custom",
			domain: "finance",
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
	});
});
