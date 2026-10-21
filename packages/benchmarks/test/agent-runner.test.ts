// 无交互 agent runner 测试：scriptedAdapter 回放，不触网。
// 覆盖：正常文本轮的成功与 token 汇总、危险命令的 allow-all 审批落盘、
// 以及超时 abort（无限流式适配器周期性让出，保证 core 循环能观察 abort）。

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LlmAdapter,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
} from "@hotpot/ai";
import { loadSession, type SessionEvent, type Settings } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentTurn } from "../src/agent-runner.ts";

let cwd: string;

const SETTINGS: Settings = {
	models: {
		high: { provider: "test", model: "test-high", apiKey: "test-key" },
		medium: { provider: "test", model: "test-medium", apiKey: "test-key" },
		low: { provider: "test", model: "test-low", apiKey: "test-key" },
	},
};

const TEST_MODEL: ModelInfo = {
	id: "test-model",
	provider: "test",
	api: "openai-completions",
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0 },
};

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "hotpot-bench-agent-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function textRound(text: string, input = 7, output = 2): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input, output } },
		{ type: "finish", reason: "stop" },
	];
}

function toolCallRound(
	id: string,
	name: string,
	inputJson: string,
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 4, output: 1 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

function spawnWorkersRound(task: string): StreamEvent[] {
	return toolCallRound(
		"m-tc-1",
		"spawn_workers",
		JSON.stringify({ workers: [{ task, modelTier: "low" }] }),
	);
}

describe("runAgentTurn", () => {
	it("文本轮成功，token 取整棵树的 assistant 消息", async () => {
		const adapter = scriptedAdapter([textRound("hello", 11, 3)]);
		const result = await runAgentTurn({
			cwd,
			prompt: "Say hello.",
			settings: SETTINGS,
			modelTier: "low",
			adapter,
			model: TEST_MODEL,
		});

		expect(result.outcome).toBe("success");
		expect(result.inputTokens).toBe(11);
		expect(result.outputTokens).toBe(3);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		const { events } = await loadSession(result.sessionFilePath);
		expect(events.some((event) => event.type === "assistant_msg")).toBe(true);
	});

	it("危险命令经 allow-all 审批执行，并落盘 asked/decided", async () => {
		await mkdir(join(cwd, "fixture-dir"), { recursive: true });
		await writeFile(join(cwd, "fixture-dir", "keep.txt"), "x\n", "utf8");
		const adapter = scriptedAdapter([
			spawnWorkersRound("Remove the fixture directory."),
			toolCallRound(
				"w-bash-1",
				"bash",
				JSON.stringify({ command: "rm -rf ./fixture-dir" }),
			),
			textRound("Removed."),
			textRound("Done."),
		]);
		const result = await runAgentTurn({
			cwd,
			prompt: "Clean up the fixture directory.",
			settings: SETTINGS,
			modelTier: "low",
			adapter,
			model: TEST_MODEL,
		});

		expect(result.outcome).toBe("success");
		expect(existsSync(join(cwd, "fixture-dir"))).toBe(false);
		const { events } = await loadSession(result.sessionFilePath);
		const asked = events.find((event) => event.type === "approval/asked");
		const decided = events.find((event) => event.type === "approval/decided");
		expect(asked).toBeDefined();
		expect(decided).toMatchObject({
			requestId: asked?.type === "approval/asked" ? asked.id : undefined,
			decision: "approved",
		});
		const bashResult = events.find(
			(event): event is Extract<SessionEvent, { type: "tool_result" }> =>
				event.type === "tool_result" && event.toolCallId === "w-bash-1",
		);
		expect(bashResult?.isError).toBe(false);
	});

	it("超时 abort 返回 aborted", async () => {
		const neverEnding: LlmAdapter = {
			api: "never-ending",
			streamChat(_req, signal: AbortSignal): AsyncIterable<StreamEvent> {
				return (async function* (): AsyncGenerator<StreamEvent> {
					while (!signal.aborted) {
						await new Promise((resolve) => setTimeout(resolve, 5));
						if (signal.aborted) {
							return;
						}
						yield { type: "text_delta", delta: "..." };
					}
				})();
			},
		};
		const result = await runAgentTurn({
			cwd,
			prompt: "Never finish.",
			settings: SETTINGS,
			modelTier: "low",
			adapter: neverEnding,
			model: TEST_MODEL,
			timeoutMs: 50,
		});

		expect(result.outcome).toBe("aborted");
	});
});
