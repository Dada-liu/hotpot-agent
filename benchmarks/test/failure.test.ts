// 失败分类测试：枚举是报告与遥测的公共口径，必须逐条钉住判定顺序。
import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/failure.ts";

describe("classifyFailure", () => {
	it("通过题没有分类", () => {
		expect(classifyFailure({ passed: true })).toBeUndefined();
	});

	it("官方判定空 patch 优先于一切文本", () => {
		expect(
			classifyFailure({
				passed: false,
				emptyPatch: true,
				reason: "agent error: x",
			}),
		).toBe("empty_patch");
		expect(classifyFailure({ passed: false, reason: "empty patch" })).toBe(
			"empty_patch",
		);
	});

	it("aborted 归为 agent_aborted", () => {
		expect(
			classifyFailure({ passed: false, agentOutcome: "aborted", reason: "x" }),
		).toBe("agent_aborted");
		expect(
			classifyFailure({
				passed: false,
				reason: "agent aborted: timeout after 900s",
			}),
		).toBe("agent_aborted");
	});

	it("上下文/输出上限优先归为 max_tokens", () => {
		expect(
			classifyFailure({
				passed: false,
				agentOutcome: "error",
				reason: "agent error: max_tokens exceeded",
			}),
		).toBe("max_tokens");
		expect(
			classifyFailure({
				passed: false,
				reason:
					"agent error: This model's maximum context length is 128000 tokens",
			}),
		).toBe("max_tokens");
	});

	it("其余 agent 失败归为 agent_error", () => {
		expect(
			classifyFailure({
				passed: false,
				agentOutcome: "error",
				reason: "agent error: adapter 500",
			}),
		).toBe("agent_error");
	});

	it("自建题的校验失败按文本区分 timeout 与 validation_failed", () => {
		expect(
			classifyFailure({
				passed: false,
				reason: "validation timed out after 60000ms",
			}),
		).toBe("timeout");
		expect(
			classifyFailure({
				passed: false,
				reason: "validation exited with 1, expected 0: assertion failed",
			}),
		).toBe("validation_failed");
	});

	it("官方判未解决归为 unresolved，无法判断时给 unknown", () => {
		expect(
			classifyFailure({
				passed: false,
				reason: "unresolved by official harness",
			}),
		).toBe("unresolved");
		expect(classifyFailure({ passed: false, reason: "failed" })).toBe(
			"unknown",
		);
		expect(classifyFailure({ passed: false })).toBe("unknown");
	});
});
