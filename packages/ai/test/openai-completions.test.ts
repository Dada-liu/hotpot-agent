import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { createOpenAICompletionsAdapter } from "../src/api/openai-completions.ts";
import { parseSseStream } from "../src/sse.ts";
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

// 测试用模型元数据：数值与 MODELS 中 gpt-4.1 保持一致
const MODEL: ModelInfo = {
	id: "gpt-4.1",
	provider: "openai",
	api: "openai-completions",
	contextWindow: 1_047_576,
	maxTokens: 32_768,
	cost: { input: 2, output: 8 },
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
		apiKey: "sk-test",
		system: "you are helpful",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		tools: [],
		...overrides,
	};
}

function neverAborted(): AbortSignal {
	return new AbortController().signal;
}

// ---- parseSseStream 拆包用例 ----

describe("parseSseStream", () => {
	it("多字节 UTF-8 字符跨 chunk 拆分后解码完整", async () => {
		const bytes = encoder.encode('data: {"c":"你好"}\n\n');
		// 切点落在「你」（UTF-8 三字节）的字节序列内部
		const cut = encoder.encode('data: {"c":"你').length - 1;
		const payloads = await collect(
			parseSseStream(streamOf(splitBytes(bytes, [cut]))),
		);
		expect(payloads).toEqual(['{"c":"你好"}']);
	});

	it("一个 JSON 行跨两个 chunk 时仍拼成一条载荷", async () => {
		const bytes = encoder.encode('data: {"a":1}\n\ndata: {"b":2}\n\n');
		const cut = encoder.encode('data: {"a"').length;
		const payloads = await collect(
			parseSseStream(streamOf(splitBytes(bytes, [cut]))),
		);
		expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("末尾无换行时收尾仍产出最后一条载荷", async () => {
		const bytes = encoder.encode('data: {"a":1}\n\ndata: {"b":2}');
		const payloads = await collect(parseSseStream(streamOf([bytes])));
		expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("遇到 [DONE] 终止迭代且不产出该载荷", async () => {
		const bytes = encoder.encode(
			'data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n',
		);
		const payloads = await collect(parseSseStream(streamOf([bytes])));
		expect(payloads).toEqual(['{"a":1}']);
	});
});

// ---- 适配器流式解析 ----

// openai-text.sse.txt 对应的期望事件序列（usage 帧在 finish_reason 帧之后到达，故 usage 先于 finish 产出）
const TEXT_EVENTS: StreamEvent[] = [
	{ type: "text_delta", delta: "你好" },
	{ type: "text_delta", delta: "，世界" },
	{ type: "usage", usage: { input: 12, output: 5 } },
	{ type: "finish", reason: "stop" },
];

describe("createOpenAICompletionsAdapter 流式解析", () => {
	it("文本增量流：text_delta 拼接完整、usage 数值正确、finish=stop", async () => {
		const bytes = await readFixture("openai-text.sse.txt");
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
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
		const bytes = await readFixture("openai-text.sse.txt");
		// 切点 1：第一条 JSON 行中间；切点 2：「你」的三字节序列内部
		const cut1 = encoder.encode('data: {"id"').length;
		const cut2 =
			encoder.encode(
				decoder.decode(bytes).slice(0, decoder.decode(bytes).indexOf("你")),
			).length + 1;
		const { fetchImpl } = fakeFetch(splitBytes(bytes, [cut1, cut2]));
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
		const events = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		);
		expect(events).toEqual(TEXT_EVENTS);
	});

	it("tool_call 增量流：start/delta/end 齐全，inputDelta 拼接为合法 JSON，finish=tool_calls", async () => {
		const bytes = await readFixture("openai-tool-calls.sse.txt");
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
		const events = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		);
		expect(events).toEqual([
			{ type: "tool_call_start", id: "call_abc123", name: "bash" },
			{ type: "tool_call_delta", id: "call_abc123", inputDelta: '{"command":' },
			{ type: "tool_call_delta", id: "call_abc123", inputDelta: '"ls -la"}' },
			{ type: "usage", usage: { input: 30, output: 9 } },
			{ type: "tool_call_end", id: "call_abc123" },
			{ type: "finish", reason: "tool_calls" },
		]);
		let input = "";
		for (const e of events) {
			if (e.type === "tool_call_delta") input += e.inputDelta;
		}
		expect(JSON.parse(input)).toEqual({ command: "ls -la" });
	});
});

// ---- 适配器请求构造 ----

describe("createOpenAICompletionsAdapter 请求构造", () => {
	it("system 进 messages 首部，tools 转 function 格式，tool_result 转 role:tool 消息", async () => {
		const bytes = await readFixture("openai-text.sse.txt");
		const { fetchImpl, requests } = fakeFetch([bytes]);
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
		const req = makeRequest({
			// 末尾带斜杠，验证归一化
			baseUrl: "https://api.deepseek.com/v1/",
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
		expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
		expect(init.method).toBe("POST");
		expect(init.headers.authorization).toBe("Bearer sk-test");
		expect(init.headers["content-type"]).toBe("application/json");
		const body = JSON.parse(init.body);
		expect(body.model).toBe("gpt-4.1");
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(body.max_tokens).toBe(32_768);
		expect(body.messages).toEqual([
			{ role: "system", content: "you are helpful" },
			{ role: "user", content: "列出文件" },
			{
				role: "assistant",
				content: "好的",
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"ls"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "c1", content: "a.txt" },
			{ role: "user", content: "继续" },
		]);
		expect(body.tools).toEqual([
			{
				type: "function",
				function: {
					name: "bash",
					description: "run command",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			},
		]);
	});

	it("缺省 baseUrl 走 OpenAI 官方端点；无 tools 时请求体不带 tools 字段", async () => {
		const bytes = await readFixture("openai-text.sse.txt");
		const { fetchImpl, requests } = fakeFetch([bytes]);
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
		await collect(adapter.streamChat(makeRequest(), neverAborted()));
		expect(requests[0].url).toBe("https://api.openai.com/v1/chat/completions");
		const body = JSON.parse(requests[0].init.body);
		expect("tools" in body).toBe(false);
	});
});

// ---- 适配器错误处理 ----

describe("createOpenAICompletionsAdapter 错误处理", () => {
	it("非 2xx：LlmError 含 status 与 retry-after 秒数，message 为 body 文本", async () => {
		const errBody = encoder.encode('{"error":{"message":"rate limited"}}');
		const { fetchImpl } = fakeFetch([errBody], {
			status: 429,
			headers: { "retry-after": "30" },
		});
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
		const err: unknown = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		if (!(err instanceof LlmError)) throw new Error("unreachable");
		expect(err.code).toBe("http_429");
		expect(err.status).toBe(429);
		expect(err.retryAfter).toBe(30);
		expect(err.message).toBe('{"error":{"message":"rate limited"}}');
	});

	it("错误 body 超过 500 字符时截断进 message", async () => {
		const errBody = encoder.encode(`{"detail":"${"x".repeat(600)}"}`);
		const { fetchImpl } = fakeFetch([errBody], { status: 500 });
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
		const err: unknown = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		).catch((e: unknown) => e);
		if (!(err instanceof LlmError)) throw new Error("unreachable");
		expect(err.code).toBe("http_500");
		expect(err.retryAfter).toBeUndefined();
		expect(err.message.length).toBe(500);
	});

	it("流提前结束（无 finish_reason）时抛 truncated_stream", async () => {
		const bytes = encoder.encode(
			'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
		);
		const { fetchImpl } = fakeFetch([bytes]);
		const adapter = createOpenAICompletionsAdapter(fetchImpl);
		const err: unknown = await collect(
			adapter.streamChat(makeRequest(), neverAborted()),
		).catch((e: unknown) => e);
		if (!(err instanceof LlmError)) throw new Error("unreachable");
		expect(err.code).toBe("truncated_stream");
	});
});
