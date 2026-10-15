// M2 多 agent 编排的基础设施：tool_result 归属 agentId 后 derive 按 agent 过滤，
// 以及多个 agent 并发 append 同一会话文件时不互相损坏

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveMessages } from "../src/session/derive.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { createSession, loadSession } from "../src/session/store.ts";

// 每个用例一个临时 home，隔离文件系统
let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-multi-agent-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const TS = "2026-10-10T08:00:00.000Z";

function userMsg(agentId: string, text: string): SessionEvent {
	return {
		type: "user_msg",
		id: `u-${agentId}`,
		ts: TS,
		agentId,
		content: text,
	};
}

function assistantWithCalls(
	agentId: string,
	calls: { id: string; name: string }[],
): SessionEvent {
	return {
		type: "assistant_msg",
		id: `a-${agentId}`,
		ts: TS,
		agentId,
		content: calls.map((c) => ({
			type: "tool_call" as const,
			...c,
			input: {},
		})),
		usage: { input: 1, output: 1 },
		model: "test-model",
		tier: "high",
	};
}

function toolResult(
	agentId: string,
	toolCallId: string,
	content: string,
): SessionEvent {
	return {
		type: "tool_result",
		id: `r-${toolCallId}`,
		ts: TS,
		agentId,
		toolCallId,
		content,
		isError: false,
	};
}

// main 与 worker-1 的用户消息、assistant 消息、tool_result 交错排列
function interleavedEvents(): SessionEvent[] {
	return [
		{
			type: "meta",
			sessionId: "s",
			createdAt: TS,
			cwd: "/x",
			formatVersion: 1,
		},
		userMsg("main", "主 agent 任务"),
		assistantWithCalls("main", [
			{ id: "tc-m1", name: "bash" },
			{ id: "tc-m2", name: "read" },
		]),
		userMsg("worker-1", "子 agent 任务"),
		assistantWithCalls("worker-1", [{ id: "tc-w1", name: "bash" }]),
		toolResult("worker-1", "tc-w1", "worker 的结果"),
		toolResult("main", "tc-m1", "main 的第一个结果"),
		toolResult("main", "tc-m2", "main 的第二个结果"),
	];
}

describe("deriveMessages 多 agent 过滤", () => {
	it("tool_result 按 agentId 过滤：main 只见自己的结果，且连续结果仍合并为一条 user 消息", () => {
		const messages = deriveMessages(interleavedEvents(), "main");

		// user 消息 + assistant 消息 + 合并后的 tool_result user 消息
		expect(messages).toHaveLength(3);
		expect(messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "主 agent 任务" }],
		});
		expect(messages[1]?.role).toBe("assistant");

		// main 的两个 tool_result 之间隔着 worker-1 的事件，过滤后连续 → 合并
		const resultMessage = messages[2];
		expect(resultMessage?.role).toBe("user");
		const blocks = resultMessage?.content ?? [];
		expect(blocks).toHaveLength(2);
		expect(
			blocks.every(
				(b) => b.type === "tool_result" && b.toolCallId.startsWith("tc-m"),
			),
		).toBe(true);
		expect(
			blocks.map((b) => (b.type === "tool_result" ? b.content : "")),
		).toEqual(["main 的第一个结果", "main 的第二个结果"]);
	});

	it("worker-1 只见自己的 tool_result", () => {
		const messages = deriveMessages(interleavedEvents(), "worker-1");
		expect(messages).toHaveLength(3);
		const resultMessage = messages[2];
		expect(resultMessage).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					toolCallId: "tc-w1",
					content: "worker 的结果",
					isError: false,
				},
			],
		});
	});

	it("兼容旧日志：tool_result 无 agentId 时视为 main", () => {
		const events: SessionEvent[] = [
			{
				type: "meta",
				sessionId: "s",
				createdAt: TS,
				cwd: "/x",
				formatVersion: 1,
			},
			assistantWithCalls("main", [{ id: "tc-1", name: "bash" }]),
			// M1 旧日志：tool_result 不带 agentId 字段
			{
				type: "tool_result",
				id: "r-1",
				ts: TS,
				toolCallId: "tc-1",
				content: "旧日志结果",
				isError: false,
			},
		];

		const mainMessages = deriveMessages(events, "main");
		expect(mainMessages).toHaveLength(2);
		expect(mainMessages[1]?.content[0]).toMatchObject({
			type: "tool_result",
			toolCallId: "tc-1",
		});

		// worker 视角下旧日志的 tool_result 不可见（已按 main 归属）
		expect(deriveMessages(events, "worker-1")).toHaveLength(0);
	});
});

describe("Session.append 并发安全", () => {
	it("8 个并发 append 后读回 8+1 行，逐行可解析且内容完整", async () => {
		const session = await createSession("/Users/test/project", home);

		const contents = Array.from(
			{ length: 8 },
			(_, i) => `并发结果-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
		);
		await Promise.all(
			contents.map((content, i) =>
				session.append({
					type: "tool_result",
					id: `tr-${i}`,
					ts: TS,
					agentId: "main",
					toolCallId: `tc-${i}`,
					content,
					isError: false,
				}),
			),
		);

		// 逐行 JSON.parse：任何交错写入导致的半行都会在这里失败
		const text = await readFile(session.filePath, "utf8");
		const lines = text.split("\n").filter((line) => line.trim() !== "");
		expect(lines).toHaveLength(9); // meta + 8 个 tool_result

		const parsed = lines.map((line) => JSON.parse(line) as SessionEvent);
		expect(parsed[0]?.type).toBe("meta");
		const results = parsed.slice(1);
		expect(
			results.map((e) => (e.type === "tool_result" ? e.content : "")).sort(),
		).toEqual([...contents].sort());
		// 每条事件字段完整：并发写入顺序不定，按行内 id 反查期望内容，无半行或截断
		for (const [i, event] of results.entries()) {
			if (event?.type !== "tool_result") {
				throw new Error(`line ${i + 1} is not a tool_result`);
			}
			const n = Number(event.id.replace("tr-", ""));
			expect(event.toolCallId).toBe(`tc-${n}`);
			expect(event.content).toBe(contents[n]);
			expect(event.agentId).toBe("main");
		}

		// loadSession 同样能完整读回
		const { events } = await loadSession(session.filePath);
		expect(events).toHaveLength(9);
	});
});
