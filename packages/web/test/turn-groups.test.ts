import { describe, expect, it } from "vitest";
import {
	findFinalAnswer,
	groupTranscript,
	isFinalAnswer,
	isProcessItem,
} from "../src/lib/turn-groups.ts";
import type { TranscriptEntry } from "../src/state/reducer.ts";

function user(id: string): TranscriptEntry {
	return { kind: "user", id, ts: "", agentId: "main", content: id };
}

function assistant(
	id: string,
	blocks: Extract<TranscriptEntry, { kind: "assistant" }>["content"],
): TranscriptEntry {
	return { kind: "assistant", id, ts: "", agentId: "main", content: blocks };
}

function tool(id: string): TranscriptEntry {
	return {
		kind: "tool",
		id,
		ts: "",
		agentId: "main",
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
