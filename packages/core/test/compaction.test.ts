import type { Message, ToolDeclaration } from "@hotpot/ai";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/compaction/estimate.ts";

describe("estimateTokens", () => {
	it("保守估算正文，并覆盖 system、工具 schema 与 tool 调用", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "a".repeat(400) },
					{
						type: "tool_call",
						id: "call-1",
						name: "write",
						input: { content: "b".repeat(400) },
					},
				],
			},
		];
		const tools: ToolDeclaration[] = [
			{
				name: "write",
				description: "c".repeat(200),
				parameters: {
					type: "object",
					properties: {
						content: { type: "string", description: "d".repeat(200) },
					},
				},
			},
		];

		const bodyOnly = estimateTokens(messages, "", []);
		const withSystem = estimateTokens(messages, "e".repeat(400), []);
		const withTools = estimateTokens(messages, "", tools);
		expect(bodyOnly).toBeGreaterThanOrEqual(200);
		expect(withSystem).toBeGreaterThan(bodyOnly);
		expect(withTools).toBeGreaterThan(bodyOnly);
	});

	it("中文内容不会按三字符一个 token 被低估", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "上下文".repeat(100) }],
			},
		];
		expect(estimateTokens(messages, "", [])).toBeGreaterThanOrEqual(300);
	});

	it("emoji 短 token 内容使用保守的本地估算上界", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "😀".repeat(100) }],
			},
		];
		expect(estimateTokens(messages, "", [])).toBeGreaterThanOrEqual(300);
	});
});
