// M4 Feature③：turn_end（Stop）钩子在回合包装层触发一次——以 runAgentInline
// 为最小回合，验证归属 agent、只触发一次、与 pre/post tool 共用同一 hook 链。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LlmAdapter, type StreamEvent, scriptedAdapter } from "@hotpot/ai";
import {
	ApprovalChain,
	createHookChain,
	createSession,
	loadSession,
	type ModelTier,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type OrchestrationRuntime } from "../src/runtime.ts";
import { runAgentInline } from "../src/tools/run-worker.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-hook-turn-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-hook-turn-proj-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

const STOP_ROUND: StreamEvent[] = [
	{ type: "text_delta", delta: "完成" },
	{ type: "usage", usage: { input: 10, output: 2 } },
	{ type: "finish", reason: "stop" },
];

function withAdapter(
	runtime: OrchestrationRuntime,
	adapter: LlmAdapter,
): OrchestrationRuntime {
	return {
		...runtime,
		resolveModel(tier: ModelTier) {
			return { ...runtime.resolveModel(tier), adapter };
		},
	};
}

function firedEvents(
	events: SessionEvent[],
): Extract<SessionEvent, { type: "hook/fired" }>[] {
	return events.filter(
		(e): e is Extract<SessionEvent, { type: "hook/fired" }> =>
			e.type === "hook/fired",
	);
}

describe("turn_end 钩子（runAgentInline）", () => {
	it("每个下层 agent 的回合收尾触发一次 Stop 钩子，归属该 agent", async () => {
		const session = await createSession(proj, home);
		const hooks = createHookChain(
			{
				Stop: [
					{
						matcher: "",
						hooks: [
							{ type: "command", command: "echo stop-fired > /dev/null" },
						],
					},
				],
			},
			{ session, cwd: proj, agentId: "main" },
		);
		const base = createRuntime({
			session,
			cwd: proj,
			approval: new ApprovalChain(),
			models: MODELS,
			hooks,
		});
		const runtime = withAdapter(base, scriptedAdapter([STOP_ROUND]));

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(outcome.failures).toEqual([]);
		expect(outcome.summary).toBe("完成");

		const { events } = await loadSession(session.filePath);
		const fired = firedEvents(events);
		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatchObject({
			hook: "turn_end",
			agentId: "worker-1",
			exitCode: 0,
		});
	});

	it("未配置 hooks 时不落任何 hook/fired 事件", async () => {
		const session = await createSession(proj, home);
		const base = createRuntime({
			session,
			cwd: proj,
			approval: new ApprovalChain(),
			models: MODELS,
		});
		const runtime = withAdapter(base, scriptedAdapter([STOP_ROUND]));
		await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)).toHaveLength(0);
	});
});
