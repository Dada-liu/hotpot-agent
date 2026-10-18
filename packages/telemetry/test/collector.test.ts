// Turn 采集器测试：用临时 home 造真实会话 JSONL，验证折叠结果、outcome 判定与隐私边界。
// 固定 now 到 2026-01-01T00:00:00Z，让会话日志里的确定性时间戳落在 turn 窗口内。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSession,
	type Session,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTelemetryCollector,
	type ObservedOrchestrationEvent,
	sessionEndEvent,
	sessionStartEvent,
	type TelemetryCollector,
} from "../src/collector.ts";
import {
	type TelemetryEvent,
	type TurnEndEvent,
	telemetryEventSchema,
} from "../src/events.ts";

const FIXTURE_NOW = Date.parse("2026-01-01T00:00:00.000Z");

const ERROR_EVENT: SessionEvent = {
	type: "error",
	id: "e1",
	ts: "2026-01-01T00:00:04.000Z",
	agentId: "main",
	code: "E_TEST",
	message: "failed at /Users/a/x",
};

type EventOfType<T extends TelemetryEvent["type"]> = Extract<
	TelemetryEvent,
	{ type: T }
>;

function eventsOfType<T extends TelemetryEvent["type"]>(
	events: readonly TelemetryEvent[],
	type: T,
): EventOfType<T>[] {
	return events.filter((event): event is EventOfType<T> => event.type === type);
}

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-telemetry-collector-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function createTurnSession(
	events: readonly SessionEvent[] = [],
): Promise<Session> {
	const session = await createSession(home, home);
	for (const event of events) {
		await session.append(event);
	}
	return session;
}

function createCollector(
	session: Session,
	features?: Settings["features"],
): TelemetryCollector {
	return createTelemetryCollector({
		session,
		sessionId: session.id,
		turnId: "t1",
		appVersion: "0.0.0-test",
		features,
		now: () => FIXTURE_NOW,
	});
}

async function foldOutcome(options: {
	events?: readonly SessionEvent[];
	observed?: readonly ObservedOrchestrationEvent[];
	finish?: { aborted?: boolean; planRejected?: boolean };
}): Promise<{ emitted: TelemetryEvent[]; turnEnd: TurnEndEvent }> {
	const session = await createTurnSession(options.events ?? []);
	const collector = createCollector(session);
	collector.start();
	for (const event of options.observed ?? []) {
		collector.observe(event);
	}
	const emitted = await collector.finish(options.finish);
	return { emitted, turnEnd: eventsOfType(emitted, "turn_end")[0] };
}

describe("createTelemetryCollector", () => {
	it("folds one turn from the session log into anonymous metrics", async () => {
		const session = await createSession(home, home);
		await session.append({
			type: "user_msg",
			id: "u1",
			ts: "2026-01-01T00:00:00.000Z",
			agentId: "main",
			content: "fix it",
		});
		await session.append({
			type: "assistant_msg",
			id: "a1",
			ts: "2026-01-01T00:00:01.000Z",
			agentId: "main",
			content: [
				{
					type: "tool_call",
					id: "c1",
					name: "bash",
					input: { command: "echo secret" },
				},
			],
			usage: { input: 10, output: 5 },
			model: "m",
			tier: "high",
		});
		await session.append({
			type: "tool_result",
			id: "r1",
			ts: "2026-01-01T00:00:02.000Z",
			agentId: "main",
			toolCallId: "c1",
			content: "secret output",
			isError: false,
		});
		await session.append({
			type: "assistant_msg",
			id: "a2",
			ts: "2026-01-01T00:00:03.000Z",
			agentId: "worker-1",
			content: [],
			usage: { input: 7, output: 3 },
			model: "m",
			tier: "medium",
		});
		await session.append({
			type: "error",
			id: "e1",
			ts: "2026-01-01T00:00:04.000Z",
			agentId: "worker-1",
			code: "E_TEST",
			message: "failed at /Users/a/x",
		});

		const collector = createCollector(session);
		const emitted: TelemetryEvent[] = [collector.start()];
		collector.observe({ type: "done", stopReason: "stop" });
		emitted.push(...(await collector.finish()));

		expect(eventsOfType(emitted, "turn_start")).toHaveLength(1);

		const [turnEnd] = eventsOfType(emitted, "turn_end");
		expect(turnEnd).toMatchObject({
			type: "turn_end",
			turnId: "t1",
			sessionId: session.id,
			// 树内出现 error 事件，即使 main 以 done(stop) 结束也判 error
			outcome: "error",
			inputTokens: 17,
			outputTokens: 8,
			assistantMessages: 2,
			mainSteps: 1,
			workerCount: 0,
			taskCount: 0,
		});
		expect(turnEnd.byTier.high.input).toBe(10);
		expect(turnEnd.byTier.medium.input).toBe(7);
		expect(turnEnd.byTier).toEqual({
			high: { input: 10, output: 5 },
			medium: { input: 7, output: 3 },
		});
		expect(turnEnd.byModel).toEqual({ m: { input: 17, output: 8 } });

		const llmCalls = eventsOfType(emitted, "llm_call");
		expect(llmCalls).toHaveLength(2);
		expect(llmCalls.map((event) => event.agentRole)).toEqual([
			"main",
			"worker",
		]);
		expect(llmCalls.map((event) => event.stepIndex)).toEqual([0, 0]);
		// 日志没有缓存字段时必须补 0，保持 schema 形状稳定
		expect(
			llmCalls.every(
				(event) => event.cacheReadTokens === 0 && event.cacheWriteTokens === 0,
			),
		).toBe(true);

		const toolCalls = eventsOfType(emitted, "tool_call");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({
			toolName: "bash",
			durationApprox: true,
			durationMs: 1000,
			agentRole: "main",
			isError: false,
		});

		const errors = eventsOfType(emitted, "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			phase: "turn",
			code: "E_TEST",
			agentRole: "worker",
		});
		expect(errors[0].sanitizedMessage).not.toContain("/Users/a/x");

		// 隐私边界：任何输出都不得带 prompt/工具入参/工具输出原文
		const serialized = JSON.stringify(emitted);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("fix it");

		// 折叠出的每条事件都必须能通过上报 schema
		for (const event of emitted) {
			expect(telemetryEventSchema.safeParse(event).success).toBe(true);
		}
		// turn_end 是最后一个事件
		expect(emitted.at(-1)?.type).toBe("turn_end");
	});

	it("counts spawned workers/tasks and folds their usage into the tree totals", async () => {
		const session = await createTurnSession([
			{
				type: "agent_spawn",
				id: "sp1",
				ts: "2026-01-01T00:00:00.500Z",
				parentAgentId: "main",
				agentId: "worker-1",
				role: "worker",
				task: "w",
				tier: "medium",
			},
			{
				type: "agent_spawn",
				id: "sp2",
				ts: "2026-01-01T00:00:00.600Z",
				parentAgentId: "main",
				agentId: "task-1",
				role: "task",
				task: "t",
				tier: "low",
			},
			{
				type: "agent_spawn",
				id: "sp3",
				ts: "2026-01-01T00:00:00.700Z",
				parentAgentId: "main",
				agentId: "task-2",
				role: "task",
				task: "t",
				tier: "low",
			},
			{
				type: "assistant_msg",
				id: "a1",
				ts: "2026-01-01T00:00:01.000Z",
				agentId: "worker-1",
				content: [],
				usage: { input: 2, output: 1 },
				model: "worker-model",
				tier: "medium",
			},
			{
				type: "assistant_msg",
				id: "a2",
				ts: "2026-01-01T00:00:02.000Z",
				agentId: "task-1",
				content: [{ type: "tool_call", id: "c1", name: "read", input: {} }],
				usage: { input: 3, output: 1, cacheRead: 9, cacheWrite: 4 },
				model: "task-model",
				tier: "low",
			},
			{
				type: "tool_result",
				id: "r1",
				ts: "2026-01-01T00:00:02.500Z",
				agentId: "task-1",
				toolCallId: "c1",
				content: "x",
				isError: false,
			},
		]);

		const collector = createCollector(session);
		collector.start();
		collector.observe({ type: "done", stopReason: "stop" });
		const emitted = await collector.finish();
		const [turnEnd] = eventsOfType(emitted, "turn_end");

		expect(turnEnd).toMatchObject({
			workerCount: 1,
			taskCount: 2,
			assistantMessages: 2,
			mainSteps: 0,
			inputTokens: 5,
			outputTokens: 2,
		});
		expect(turnEnd.byModel).toEqual({
			"worker-model": { input: 2, output: 1 },
			"task-model": { input: 3, output: 1 },
		});

		const taskCall = eventsOfType(emitted, "llm_call").find(
			(event) => event.agentId === "task-1",
		);
		expect(taskCall?.agentRole).toBe("task");
		expect(taskCall?.cacheReadTokens).toBe(9);
		expect(taskCall?.cacheWriteTokens).toBe(4);

		expect(eventsOfType(emitted, "tool_call")[0]).toMatchObject({
			toolName: "read",
			agentRole: "task",
			durationMs: 500,
		});
	});

	it("counts feature events and feature tool calls", async () => {
		const session = await createTurnSession([
			{
				type: "todo/set",
				id: "f1",
				ts: "2026-01-01T00:00:00.100Z",
				agentId: "main",
				todos: [],
			},
			{
				type: "hook/fired",
				id: "f2",
				ts: "2026-01-01T00:00:00.200Z",
				agentId: "main",
				hook: "post_tool",
				command: "secret command",
				exitCode: 0,
				durationMs: 5,
			},
			{
				type: "skill/loaded",
				id: "f3",
				ts: "2026-01-01T00:00:00.300Z",
				agentId: "main",
				skill: "demo",
				path: "/Users/a/SKILL.md",
			},
			{
				type: "prompt/invoked",
				id: "f4",
				ts: "2026-01-01T00:00:00.400Z",
				agentId: "main",
				name: "demo",
				args: "",
				content: "secret prompt",
			},
			{
				type: "mcp/attached",
				id: "f5",
				ts: "2026-01-01T00:00:00.500Z",
				server: "srv",
				transport: "stdio",
				tools: ["tool"],
			},
			{
				type: "assistant_msg",
				id: "a1",
				ts: "2026-01-01T00:00:01.000Z",
				agentId: "main",
				content: [
					{ type: "tool_call", id: "c1", name: "todo", input: {} },
					{ type: "tool_call", id: "c2", name: "web_search", input: {} },
					{ type: "tool_call", id: "c3", name: "web_fetch", input: {} },
					{ type: "tool_call", id: "c4", name: "mcp__srv__tool", input: {} },
					{
						type: "tool_call",
						id: "c5",
						name: "bash",
						input: { command: "echo secret" },
					},
				],
				usage: { input: 4, output: 2 },
				model: "m",
				tier: "high",
			},
		]);

		const collector = createCollector(session, { webFetch: false });
		collector.start();
		collector.observe({ type: "done", stopReason: "stop" });
		const emitted = await collector.finish();
		const usage = eventsOfType(emitted, "feature_usage");

		expect(usage.map((event) => event.feature)).toEqual([
			"todo",
			"hooks",
			"skills",
			"promptTemplates",
			"webSearch",
			"webFetch",
			"mcp",
		]);
		expect(
			Object.fromEntries(
				usage.map((event) => [
					event.feature,
					{
						events: event.events,
						toolCalls: event.toolCalls,
						enabled: event.enabled,
					},
				]),
			),
		).toEqual({
			todo: { events: 1, toolCalls: 1, enabled: true },
			hooks: { events: 1, toolCalls: 0, enabled: true },
			skills: { events: 1, toolCalls: 0, enabled: true },
			promptTemplates: { events: 1, toolCalls: 0, enabled: true },
			webSearch: { events: 0, toolCalls: 1, enabled: true },
			webFetch: { events: 0, toolCalls: 1, enabled: false },
			mcp: { events: 1, toolCalls: 1, enabled: true },
		});

		// 功能事件只上报开关与计数，命令/路径/prompt 原文不得外泄
		const serialized = JSON.stringify(emitted);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("/Users");
	});
});

describe("turn outcome", () => {
	it("reports success for a normal stop without errors", async () => {
		const { turnEnd } = await foldOutcome({
			observed: [{ type: "done", stopReason: "stop" }],
		});
		expect(turnEnd.outcome).toBe("success");
		expect(turnEnd.planUsed).toBe(false);
	});

	it("reports error when any agent in the turn logs an error", async () => {
		const { turnEnd } = await foldOutcome({
			events: [ERROR_EVENT],
			observed: [{ type: "done", stopReason: "stop" }],
		});
		expect(turnEnd.outcome).toBe("error");
	});

	it("reports error when main ends with done(error)", async () => {
		const { turnEnd } = await foldOutcome({
			observed: [{ type: "done", stopReason: "error" }],
		});
		expect(turnEnd.outcome).toBe("error");
	});

	it("reports error when main is truncated by max_tokens", async () => {
		const { turnEnd } = await foldOutcome({
			observed: [{ type: "done", stopReason: "max_tokens" }],
		});
		expect(turnEnd.outcome).toBe("error");
	});

	it("reports error when plan revisions are exhausted", async () => {
		const { turnEnd } = await foldOutcome({
			observed: [
				{ type: "plan", phase: "drafted" },
				{ type: "plan", phase: "revision_exhausted" },
				{ type: "done", stopReason: "stop" },
			],
		});
		expect(turnEnd.outcome).toBe("error");
		expect(turnEnd.planUsed).toBe(true);
	});

	it("reports aborted when the caller aborts, taking precedence over errors", async () => {
		const { emitted, turnEnd } = await foldOutcome({
			events: [ERROR_EVENT],
			observed: [{ type: "done", stopReason: "stop" }],
			finish: { aborted: true },
		});
		expect(turnEnd.outcome).toBe("aborted");
		// 中断优先于错误，但树内的 error 事件仍然保留
		expect(eventsOfType(emitted, "error")).toHaveLength(1);
	});

	it("reports aborted when main ends with done(aborted)", async () => {
		const { turnEnd } = await foldOutcome({
			observed: [{ type: "done", stopReason: "aborted" }],
		});
		expect(turnEnd.outcome).toBe("aborted");
	});

	it("reports aborted when the user rejected the plan", async () => {
		const { emitted, turnEnd } = await foldOutcome({
			observed: [
				{ type: "plan", phase: "drafted" },
				{ type: "plan", phase: "denied" },
			],
			finish: { planRejected: true },
		});
		expect(turnEnd.outcome).toBe("aborted");
		expect(turnEnd.planUsed).toBe(true);
		expect(eventsOfType(emitted, "turn_end")).toHaveLength(1);
	});

	it("does not treat a plan denial as aborted without planRejected", async () => {
		const { turnEnd } = await foldOutcome({
			observed: [
				{ type: "plan", phase: "drafted" },
				{ type: "plan", phase: "denied" },
				{ type: "plan", phase: "approved" },
				{ type: "done", stopReason: "stop" },
			],
		});
		expect(turnEnd.outcome).toBe("success");
	});

	it("ignores transient orchestration event types", async () => {
		const { turnEnd } = await foldOutcome({
			observed: [
				{ type: "text" },
				{ type: "tool_call" },
				{ type: "tool_result" },
				{ type: "done", stopReason: "stop" },
			],
		});
		expect(turnEnd.outcome).toBe("success");
	});
});

describe("session lifecycle events", () => {
	it("builds a session_start event", () => {
		const event = sessionStartEvent({
			sessionId: "s1",
			resumed: true,
			appVersion: "1.2.3",
			features: { todo: false },
		});
		expect(event).toMatchObject({
			type: "session_start",
			sessionId: "s1",
			resumed: true,
			appVersion: "1.2.3",
			features: { todo: false },
		});
		expect(typeof event.eventId).toBe("string");
		expect(telemetryEventSchema.safeParse(event).success).toBe(true);
	});

	it("builds a session_end event with the elapsed duration", () => {
		const endedAt = Date.parse("2026-01-01T00:00:10.000Z");
		const event = sessionEndEvent({
			sessionId: "s1",
			startedAt: Date.parse("2026-01-01T00:00:04.000Z"),
			turns: 3,
			errors: 1,
			now: () => endedAt,
		});
		expect(event).toEqual({
			eventId: expect.any(String),
			ts: "2026-01-01T00:00:10.000Z",
			type: "session_end",
			sessionId: "s1",
			durationMs: 6000,
			turns: 3,
			errors: 1,
		});
		expect(telemetryEventSchema.safeParse(event).success).toBe(true);
	});
});
