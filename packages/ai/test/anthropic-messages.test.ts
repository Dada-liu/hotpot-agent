import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { createAnthropicMessagesAdapter } from "../src/api/anthropic-messages.ts";
import {
	type ChatRequest,
	type FetchLike,
	LlmError,
	type ModelInfo,
	type StreamEvent,
} from "../src/types.ts";

// ---- 测试辅助 ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 测试用模型元数据：数值与 MODELS 中 claude-sonnet-4-5 保持一致
const MODEL: ModelInfo = {
	id: "claude-sonnet-4-5",
	provider: "anthropic",
	api: "anthropic-messages",
	contextWindow: 200_000,
	maxTokens: 64_000,
	cost: { input: 3, output: 15 },
};

// 把字节数组按指定切点拆成多个 chunk，模拟 TCP 拆包
function splitBytes(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let prev = 0;
	for (const cut of cuts) {
		chunks.push(bytes.slice(prev, cut));
		prev = cut;
	}
	chunks.push(bytes.slice(prev));
	return chunks;
}

// 把若干字节 chunk 包装成 ReadableStream，模拟 fetch 响应体
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

type CapturedRequest = { url: string; init: Parameters<FetchLike>[1] };

// 构造注入用的 FetchLike fake：回放给定字节流；requests 回捞实际请求参数
function fakeFetch(
	chunks: Uint8Array[],
	options?: { status?: number; headers?: Record<string, string> },
): { fetchImpl: FetchLike; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const status = options?.status ?? 200;
	const fetchImpl: FetchLike = (url, init) => {
		requests.push({ url, init });
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			headers: new Headers(options?.headers),
			body: streamOf(chunks),
		});
	};
	return { fetchImpl, requests };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}

// 读取 SSE 固件文件（原始字节）
function readFixture(name: string): Promise<Uint8Array> {
	return readFile(new URL(`./fixtures/${name}`, import.meta.url));
}

function makeRequest(overrides?: Partial<ChatRequest>): ChatRequest {
	return {
		model: MODEL,
		apiKey: "sk-ant-test",
		system: "you are helpful",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		tools: [],
		...overrides,
	};
}

function neverAborted(): AbortSignal {
	return new AbortController().signal;
}

// ---- 适配器流式解析 ----

// anthropic-text.sse.txt 对应的期望事件序列（usage 在 message_delta 处合并产出，先于 finish）
const TEXT_EVENTS: StreamEvent[] = [
	{ type: "text_delta", delta: "你好" },
	{ type: "text_delta", delta: "，世界" },
	{ type: "usage", usage: { input: 25, output: 8, cacheRead: 18 } },
	{ type: "finish", reason: "stop" },
];

describe("createAnthropicMessagesAdapter 流式解析", () => {
	it("文本增量流：text_delta 拼接完整、end_turn→stop、usage 含 cacheRead", async () => {
		const bytes = await readFixture("anthropic-text.sse.txt");
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const events = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		);
		expect(events).toEqual(TEXT_EVENTS);
		const text = events
			.filter((e) => e.type === "text_delta")
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("你好，世界");
	});

	it("固件跨 chunk 拆分（多字节字符内部 + JSON 行中间）后事件序列不变", async () => {
		const bytes = await readFixture("anthropic-text.sse.txt");
		// 切点 1：第一条 data JSON 行中间；切点 2：「你」的三字节序列内部
		const cut1 = encoder.encode(
			'event: message_start\ndata: {"type":"message',
		).length;
		const cut2 =
			encoder.encode(
				decoder.decode(bytes).slice(0, decoder.decode(bytes).indexOf("你")),
			).length + 1;
		const { fetchImpl } = fakeFetch(splitBytes(bytes, [cut1, cut2]));
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const events = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		);
		expect(events).toEqual(TEXT_EVENTS);
	});

	it("tool_use 流：tool_call_start/delta/end 齐全，inputDelta 拼接为合法 JSON，tool_use→tool_calls", async () => {
		const bytes = await readFixture("anthropic-tool-calls.sse.txt");
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const events = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		);
		expect(events).toEqual([
			{ type: "tool_call_start", id: "toolu_01abc", name: "bash" },
			{ type: "tool_call_delta", id: "toolu_01abc", inputDelta: '{"command":' },
			{ type: "tool_call_delta", id: "toolu_01abc", inputDelta: '"ls -la"}' },
			{ type: "tool_call_end", id: "toolu_01abc" },
			{
				type: "usage",
				usage: { input: 30, output: 15, cacheRead: 12, cacheWrite: 40 },
			},
			{ type: "finish", reason: "tool_calls" },
		]);
		let input = "";
		for (const e of events) {
			if (e.type === "tool_call_delta") input += e.inputDelta;
		}
		expect(JSON.parse(input)).toEqual({ command: "ls -la" });
	});

	it("thinking 块：thinking_delta→reasoning_delta，signature_delta 忽略，text 块不受影响", async () => {
		const bytes = await readFixture("anthropic-thinking.sse.txt");
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const events = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		);
		expect(events).toEqual([
			{ type: "reasoning_delta", delta: "先想想" },
			{ type: "text_delta", delta: "答案" },
			{ type: "usage", usage: { input: 10, output: 20 } },
			{ type: "finish", reason: "stop" },
		]);
	});

	it("stop_reason=max_tokens 映射为 finish=max_tokens", async () => {
		const bytes = encoder.encode(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_04","usage":{"input_tokens":7,"output_tokens":1}}}\n\n' +
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":64}}\n\n' +
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		);
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const events = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		);
		expect(events).toEqual([
			{ type: "usage", usage: { input: 7, output: 64 } },
			{ type: "finish", reason: "max_tokens" },
		]);
	});
});

// ---- 适配器请求构造 ----

describe("createAnthropicMessagesAdapter 请求构造", () => {
	it("system 为顶层字段，messages 块转线格式，tools 转 input_schema，头部带 anthropic-version", async () => {
		const bytes = await readFixture("anthropic-text.sse.txt");
		const { fetchImpl, requests } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const req = makeRequest({
			// 末尾带斜杠，验证归一化
			baseUrl: "https://proxy.example.com/",
			messages: [
				{ role: "user", content: [{ type: "text", text: "列出文件" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "好的" },
						{
							type: "tool_call",
							id: "c1",
							name: "bash",
							input: { command: "ls" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							toolCallId: "c1",
							content: "a.txt",
							isError: false,
						},
						{ type: "text", text: "继续" },
					],
				},
			],
			tools: [
				{
					name: "bash",
					description: "run command",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			],
		});
		await collect(adapter.streamChat(req, neverAborted()));
		expect(requests).toHaveLength(1);
		const { url, init } = requests[0];
		expect(url).toBe("https://proxy.example.com/v1/messages");
		expect(init.method).toBe("POST");
		expect(init.headers["x-api-key"]).toBe("sk-ant-test");
		expect(init.headers["anthropic-version"]).toBe("2023-06-01");
		expect(init.headers["content-type"]).toBe("application/json");
		const body = JSON.parse(init.body);
		expect(body.model).toBe("claude-sonnet-4-5");
		expect(body.stream).toBe(true);
		expect(body.max_tokens).toBe(64_000);
		expect(body.system).toBe("you are helpful");
		expect(body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "列出文件" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "好的" },
					{
						type: "tool_use",
						id: "c1",
						name: "bash",
						input: { command: "ls" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "c1",
						content: "a.txt",
						is_error: false,
					},
					{ type: "text", text: "继续" },
				],
			},
		]);
		expect(body.tools).toEqual([
			{
				name: "bash",
				description: "run command",
				input_schema: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				},
			},
		]);
	});

	it("缺省 baseUrl 走 Anthropic 官方端点；无 tools 时请求体不带 tools 字段", async () => {
		const bytes = await readFixture("anthropic-text.sse.txt");
		const { fetchImpl, requests } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		await collect(adapter.streamChat(makeRequest(), neverAborted()));
		expect(requests[0].url).toBe("https://api.anthropic.com/v1/messages");
		const body = JSON.parse(requests[0].init.body);
		expect("tools" in body).toBe(false);
	});
});

// ---- 适配器错误处理 ----

describe("createAnthropicMessagesAdapter 错误处理", () => {
	it("非 2xx：LlmError 含 status 与 retry-after 秒数，message 为 body 文本", async () => {
		const errBody = encoder.encode(
			'{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
		);
		const { fetchImpl } = fakeFetch([errBody], {
			status: 429,
			headers: { "retry-after": "30" },
		});
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const err: unknown = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		if (!(err instanceof LlmError)) throw new Error("unreachable");
		expect(err.code).toBe("http_429");
		expect(err.status).toBe(429);
		expect(err.retryAfter).toBe(30);
		expect(err.message).toBe(
			'{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
		);
	});

	it("错误 body 超过 500 字符时截断进 message", async () => {
		const errBody = encoder.encode(`{"detail":"${"x".repeat(600)}"}`);
		const { fetchImpl } = fakeFetch([errBody], { status: 500 });
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const err: unknown = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		).catch((e: unknown) => e);
		if (!(err instanceof LlmError)) throw new Error("unreachable");
		expect(err.code).toBe("http_500");
		expect(err.retryAfter).toBeUndefined();
		expect(err.message.length).toBe(500);
	});

	it("流提前结束（无 message_delta stop_reason）时抛 truncated_stream", async () => {
		const bytes = encoder.encode(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_05","usage":{"input_tokens":3,"output_tokens":1}}}\n\n' +
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
		);
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const err: unknown = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		).catch((e: unknown) => e);
		if (!(err instanceof LlmError)) throw new Error("unreachable");
		expect(err.code).toBe("truncated_stream");
	});

	it("流内 error 事件抛出 LlmError，code 携带 Anthropic 错误类型", async () => {
		const bytes = encoder.encode(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_06","usage":{"input_tokens":3,"output_tokens":1}}}\n\n' +
				'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
		);
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createAnthropicMessagesAdapter(fetchImpl);
		const err: unknown = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		).catch((e: unknown) => e);
		if (!(err instanceof LlmError)) throw new Error("unreachable");
		expect(err.code).toBe("stream_overloaded_error");
		expect(err.message).toBe("Overloaded");
	});
});
