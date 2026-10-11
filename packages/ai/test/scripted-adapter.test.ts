import { describe, expect, it } from "vitest";
import { scriptedAdapter } from "../src/testing/scripted-adapter.ts";
import type { ChatRequest, StreamEvent } from "../src/types.ts";

// 固定请求与信号：scriptedAdapter 不读请求内容，仅为满足签名
const REQ: ChatRequest = {
	model: {
		id: "test-model",
		provider: "test",
		api: "openai-completions",
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 0, output: 0 },
	},
	apiKey: "k",
	system: "s",
	messages: [],
	tools: [],
};

async function collect(
	iter: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of iter) {
		out.push(event);
	}
	return out;
}

describe("scriptedAdapter", () => {
	it("按调用次序依次回放每轮脚本", async () => {
		const script: StreamEvent[][] = [
			[
				{ type: "text_delta", delta: "第一轮" },
				{ type: "finish", reason: "stop" },
			],
			[
				{ type: "text_delta", delta: "第二轮" },
				{ type: "usage", usage: { input: 1, output: 1 } },
				{ type: "finish", reason: "stop" },
			],
		];
		const adapter = scriptedAdapter(script);
		expect(adapter.api).toBe("scripted");

		const signal = new AbortController().signal;
		expect(await collect(adapter.streamChat(REQ, signal))).toEqual(script[0]);
		expect(await collect(adapter.streamChat(REQ, signal))).toEqual(script[1]);
	});

	it("脚本耗尽后再调用在迭代时抛明确错误", async () => {
		const adapter = scriptedAdapter([[{ type: "finish", reason: "stop" }]]);
		const signal = new AbortController().signal;
		await collect(adapter.streamChat(REQ, signal));
		await expect(collect(adapter.streamChat(REQ, signal))).rejects.toThrow(
			/exhausted/,
		);
	});

	it("空脚本第一次调用即抛错", async () => {
		const adapter = scriptedAdapter([]);
		await expect(
			collect(adapter.streamChat(REQ, new AbortController().signal)),
		).rejects.toThrow(/exhausted/);
	});
});
