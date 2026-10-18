// usage 统计测试：token 聚合（既有语义）+ M4 功能用量（开关/事件/工具调用）。
import type { SessionEvent } from "@hotpot/core";
import { describe, expect, it } from "vitest";
import { summarizeUsage } from "../src/usage.ts";

const ts = "2026-10-18T00:00:00.000Z";

function assistant(
	id: string,
	toolNames: string[],
	usage: { input: number; output: number },
): SessionEvent {
	return {
		type: "assistant_msg",
		id,
		ts,
		agentId: "worker-1",
		content: toolNames.map((name, i) => ({
			type: "tool_call" as const,
			id: `${id}-tc-${i}`,
			name,
			input: {},
		})),
		usage,
		model: "m",
		tier: "low",
	};
}

const events: SessionEvent[] = [
	{ type: "meta", sessionId: "s", createdAt: ts, cwd: "/p", formatVersion: 1 },
	assistant("a1", ["todo", "read"], { input: 10, output: 5 }),
	{
		type: "todo/set",
		id: "t1",
		ts,
		agentId: "worker-1",
		todos: [{ content: "x", status: "pending" }],
	},
	{
		type: "hook/fired",
		id: "h1",
		ts,
		agentId: "main",
		hook: "pre_tool",
		command: "true",
		exitCode: 0,
		durationMs: 3,
	},
	{
		type: "skill/loaded",
		id: "k1",
		ts,
		agentId: "worker-1",
		skill: "commit",
		path: "/p/SKILL.md",
	},
	{
		type: "prompt/invoked",
		id: "p1",
		ts,
		agentId: "main",
		name: "commit",
		args: "",
		content: "body",
	},
	{
		type: "mcp/attached",
		id: "m1",
		ts,
		server: "fs",
		transport: "stdio",
		tools: ["mcp__fs__read"],
	},
	assistant("a2", ["web_search", "web_fetch", "mcp__fs__read"], {
		input: 20,
		output: 7,
	}),
];

describe("summarizeUsage", () => {
	it("token 聚合既有语义不变", () => {
		const summary = summarizeUsage(events);
		expect(summary.total).toEqual({ input: 30, output: 12 });
		expect(summary.byTier.low).toEqual({ input: 30, output: 12, count: 2 });
		expect(summary.byAgent["worker-1"]).toEqual({ input: 30, output: 12 });
	});

	it("M4 功能用量：事件条数与工具调用数按功能归属，开关缺省全开", () => {
		const { features } = summarizeUsage(events);
		expect(features.todo).toEqual({ enabled: true, events: 1, toolCalls: 1 });
		expect(features.hooks).toEqual({ enabled: true, events: 1, toolCalls: 0 });
		expect(features.skills).toEqual({ enabled: true, events: 1, toolCalls: 0 });
		expect(features.promptTemplates).toEqual({
			enabled: true,
			events: 1,
			toolCalls: 0,
		});
		expect(features.webSearch).toEqual({
			enabled: true,
			events: 0,
			toolCalls: 1,
		});
		expect(features.webFetch).toEqual({
			enabled: true,
			events: 0,
			toolCalls: 1,
		});
		expect(features.mcp).toEqual({ enabled: true, events: 1, toolCalls: 1 });
	});

	it("settings.features 关闭时 enabled=false（用量照常统计）", () => {
		const { features } = summarizeUsage(events, {
			todo: false,
			webSearch: false,
			mcp: false,
		});
		expect(features.todo).toEqual({ enabled: false, events: 1, toolCalls: 1 });
		expect(features.webSearch.enabled).toBe(false);
		expect(features.mcp.enabled).toBe(false);
		// 未显式关闭的缺省仍开
		expect(features.hooks.enabled).toBe(true);
	});
});
