import { describe, expect, it } from "vitest";
import {
	findFinalAnswer,
	groupTranscript,
	isFinalAnswer,
	isMainChatEntry,
	isProcessItem,
} from "../src/lib/turn-groups.ts";
import type { TranscriptEntry } from "../src/state/reducer.ts";

function user(id: string): TranscriptEntry {
	return { kind: "user", id, ts: "", agentId: "main", content: id };
}

function assistant(
	id: string,
	blocks: Extract<TranscriptEntry, { kind: "assistant" }>["content"],
	agentId = "main",
): TranscriptEntry {
	return { kind: "assistant", id, ts: "", agentId, content: blocks };
}

function tool(id: string, agentId = "main"): TranscriptEntry {
	return {
		kind: "tool",
		id,
		ts: "",
		agentId,
		toolCallId: id,
		name: "bash",
		input: {},
	};
}

describe("groupTranscript", () => {
	it("按 user 消息切组，user 之后的条目归入当前组", () => {
		const t = [
			user("u1"),
			tool("t1"),
			assistant("a1", []),
			user("u2"),
			tool("t2"),
		];
		const groups = groupTranscript(t);
		expect(groups).toHaveLength(2);
		expect(groups[0].user?.id).toBe("u1");
		expect(groups[0].items.map((e) => e.id)).toEqual(["t1", "a1"]);
		expect(groups[1].user?.id).toBe("u2");
		expect(groups[1].items.map((e) => e.id)).toEqual(["t2"]);
	});

	it("无 user 条目时整段归入 user=null 的组", () => {
		const groups = groupTranscript([tool("t1"), tool("t2")]);
		expect(groups).toHaveLength(1);
		expect(groups[0].user).toBeNull();
		expect(groups[0].items).toHaveLength(2);
	});
});

describe("isFinalAnswer / findFinalAnswer", () => {
	it("含文本且无 tool_call 的 assistant 是最终回答", () => {
		expect(
			isFinalAnswer(assistant("a", [{ type: "text", text: "结果" }])),
		).toBe(true);
	});

	it("带 tool_call 的 assistant（含思考文本）不是最终回答", () => {
		expect(
			isFinalAnswer(
				assistant("a", [
					{ type: "text", text: "我先看看" },
					{ type: "tool_call", id: "c1", name: "read", input: {} },
				]),
			),
		).toBe(false);
	});

	it("findFinalAnswer 取最后一个纯文本 assistant", () => {
		const items = [
			assistant("a1", [
				{ type: "text", text: "思考" },
				{ type: "tool_call", id: "c1", name: "read", input: {} },
			]),
			tool("t1"),
			assistant("a2", [{ type: "text", text: "中间结论" }]),
			assistant("a3", [{ type: "text", text: "最终回答" }]),
		];
		expect(findFinalAnswer(items)?.id).toBe("a3");
	});
});

describe("isProcessItem", () => {
	it("assistant 与 tool 是过程条目，其余不是", () => {
		expect(isProcessItem(assistant("a", []))).toBe(true);
		expect(isProcessItem(tool("t"))).toBe(true);
		expect(
			isProcessItem({
				kind: "plan",
				id: "p",
				ts: "",
				phase: "drafted",
			}),
		).toBe(false);
	});
});

describe("isMainChatEntry", () => {
	it("main 的 user/assistant/tool/error 进主对话区", () => {
		expect(isMainChatEntry(user("u"))).toBe(true);
		expect(isMainChatEntry(assistant("a", []))).toBe(true);
		expect(isMainChatEntry(tool("t"))).toBe(true);
		expect(
			isMainChatEntry({
				kind: "error",
				id: "e",
				ts: "",
				agentId: "main",
				code: "E",
				message: "m",
			}),
		).toBe(true);
	});

	it("worker/task 的思考、工具与输出不进主对话区", () => {
		const workerError: TranscriptEntry = {
			kind: "error",
			id: "e",
			ts: "",
			agentId: "worker-1",
			code: "E",
			message: "m",
		};
		expect(isMainChatEntry(tool("t", "worker-1"))).toBe(false);
		expect(
			isMainChatEntry(
				assistant("a", [{ type: "text", text: "思考" }], "task-1"),
			),
		).toBe(false);
		expect(isMainChatEntry(workerError)).toBe(false);
	});

	it("plan 与 approval 无 agentId，作为常驻交互保留", () => {
		expect(
			isMainChatEntry({ kind: "plan", id: "p", ts: "", phase: "drafted" }),
		).toBe(true);
		expect(
			isMainChatEntry({
				kind: "approval",
				id: "ap",
				ts: "",
				requestId: "r",
				approvalType: "tool",
				summary: "s",
			}),
		).toBe(true);
	});

	it("过滤后分组语义不变：worker 条目消失，组仍按 user 切分", () => {
		const t = [
			user("u1"),
			tool("t1"),
			tool("t2", "worker-1"),
			assistant("a1", [{ type: "text", text: "最终" }]),
			user("u2"),
			assistant("a2", [], "task-1"),
		];
		const groups = groupTranscript(t.filter(isMainChatEntry));
		expect(groups).toHaveLength(2);
		expect(groups[0].items.map((e) => e.id)).toEqual(["t1", "a1"]);
		expect(groups[1].items.map((e) => e.id)).toEqual([]);
	});
});
