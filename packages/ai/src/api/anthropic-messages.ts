// Anthropic Messages 协议适配器。
// 职责：统一 ChatRequest → /v1/messages 请求体；SSE 事件流 → 统一 StreamEvent。
// Anthropic 的事件类型不在 SSE event: 行上消费，而在 data JSON 的 type 字段里区分。

import { parseSseStream } from "../sse.ts";
import {
	type ChatRequest,
	type FetchLike,
	type FinishReason,
	type LlmAdapter,
	LlmError,
	type Message,
	type StreamEvent,
	type ToolDeclaration,
	type Usage,
} from "../types.ts";

// ---- 上行（请求）线格式 ----

type AntContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string;
			is_error: boolean;
	  };

type AntMessage = { role: "user" | "assistant"; content: AntContentBlock[] };

// ---- 下行（响应事件）线格式 ----

type AntUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
};

type AntEvent =
	| { type: "message_start"; message: { usage?: AntUsage } }
	| {
			type: "content_block_start";
			index: number;
			content_block: { type: string; id?: string; name?: string };
	  }
	| {
			type: "content_block_delta";
			index: number;
			delta: {
				type: string;
				text?: string;
				partial_json?: string;
				thinking?: string;
			};
	  }
	| { type: "content_block_stop"; index: number }
	| {
			type: "message_delta";
			delta: { stop_reason?: string | null };
			usage?: AntUsage;
	  }
	| { type: "message_stop" }
	| { type: "ping" }
	| { type: "error"; error: { type: string; message: string } };

// 统一 Message 数组 → Anthropic messages 线格式：
// 块结构一一对应，仅字段改名（tool_call→tool_use、toolCallId→tool_use_id、isError→is_error）；
// system 不进 messages，由请求体顶层 system 字段承载
function toAntMessages(messages: Message[]): AntMessage[] {
	return messages.map((msg) => ({
		role: msg.role,
		content: msg.content.map((block): AntContentBlock => {
			if (block.type === "text") {
				return { type: "text", text: block.text };
			}
			if (block.type === "tool_call") {
				return {
					type: "tool_use",
					id: block.id,
					name: block.name,
					input: block.input,
				};
			}
			return {
				type: "tool_result",
				tool_use_id: block.toolCallId,
				content: block.content,
				is_error: block.isError,
			};
		}),
	}));
}

function toAntTool(tool: ToolDeclaration) {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	};
}

// Anthropic stop_reason → 统一 FinishReason；未映射值（stop_sequence / refusal 等）归入 error
function mapStopReason(raw: string): FinishReason {
	switch (raw) {
		case "end_turn":
			return "stop";
		case "tool_use":
			return "tool_calls";
		case "max_tokens":
			return "max_tokens";
		default:
			return "error";
	}
}

// 读取完整响应体文本（用于非 2xx 错误响应）
async function readBodyText(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

// 创建 Anthropic Messages 适配器。fetchImpl 为注入点：测试传 fake，生产默认用全局 fetch
export function createAnthropicMessagesAdapter(
	fetchImpl?: FetchLike,
): LlmAdapter {
	const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));

	async function* streamChat(
		req: ChatRequest,
		signal: AbortSignal,
	): AsyncIterable<StreamEvent> {
		// baseUrl 默认走 Anthropic 官方端点；末尾斜杠归一化
		const baseUrl = (req.baseUrl ?? "https://api.anthropic.com").replace(
			/\/+$/,
			"",
		);
		const res = await doFetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				"x-api-key": req.apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: req.model.id,
				max_tokens: req.model.maxTokens,
				stream: true,
				system: req.system,
				messages: toAntMessages(req.messages),
				...(req.tools.length > 0 ? { tools: req.tools.map(toAntTool) } : {}),
			}),
			signal,
		});

		if (!res.ok) {
			// 错误 body 截前 500 字符进 message；retry-after 头（秒）透传给上层做退避
			const text = res.body === null ? "" : await readBodyText(res.body);
			const retryAfterHeader = res.headers.get("retry-after");
			const retryAfter =
				retryAfterHeader === null
					? Number.NaN
					: Number.parseInt(retryAfterHeader, 10);
			throw new LlmError(text.slice(0, 500), `http_${res.status}`, {
				status: res.status,
				retryAfter: Number.isNaN(retryAfter) ? undefined : retryAfter,
			});
		}
		if (res.body === null) {
			throw new LlmError(
				"anthropic-messages: response body is null",
				"empty_response",
			);
		}

		// 进行中的 content_block，按 index 跟踪：kind 区分 text/tool_use/thinking，tool_use 记 id
		const blocks = new Map<number, { kind: string; id: string }>();
		// usage 分两处到达：message_start 带 input（与缓存读/写），message_delta 带最终 output；合并后在 message_delta 处产出
		let input = 0;
		let output = 0;
		let cacheRead: number | undefined;
		let cacheWrite: number | undefined;
		let finishReason: FinishReason | undefined;

		for await (const payload of parseSseStream(res.body)) {
			if (payload === "") continue;
			const event = JSON.parse(payload) as AntEvent;
			switch (event.type) {
				case "message_start": {
					const usage = event.message.usage;
					if (usage) {
						input = usage.input_tokens ?? 0;
						if (usage.cache_read_input_tokens !== undefined) {
							cacheRead = usage.cache_read_input_tokens;
						}
						if (usage.cache_creation_input_tokens !== undefined) {
							cacheWrite = usage.cache_creation_input_tokens;
						}
					}
					break;
				}
				case "content_block_start": {
					const block = event.content_block;
					if (block.type === "tool_use") {
						const id = block.id ?? "";
						blocks.set(event.index, { kind: "tool_use", id });
						yield { type: "tool_call_start", id, name: block.name ?? "" };
					} else {
						// text / thinking 块开始本身不产生统一事件，delta 到来时再区分
						blocks.set(event.index, { kind: block.type, id: "" });
					}
					break;
				}
				case "content_block_delta": {
					const delta = event.delta;
					if (delta.type === "text_delta" && delta.text) {
						yield { type: "text_delta", delta: delta.text };
					} else if (delta.type === "input_json_delta" && delta.partial_json) {
						yield {
							type: "tool_call_delta",
							id: blocks.get(event.index)?.id ?? "",
							inputDelta: delta.partial_json,
						};
					} else if (delta.type === "thinking_delta" && delta.thinking) {
						yield { type: "reasoning_delta", delta: delta.thinking };
					}
					// signature_delta 等其余增量类型对上层无意义，忽略
					break;
				}
				case "content_block_stop": {
					const block = blocks.get(event.index);
					// 仅 tool_use 块的结束映射为 tool_call_end；text/thinking 块结束无对应事件
					if (block?.kind === "tool_use") {
						yield { type: "tool_call_end", id: block.id };
					}
					blocks.delete(event.index);
					break;
				}
				case "message_delta": {
					if (event.usage) {
						output = event.usage.output_tokens ?? output;
						if (event.usage.input_tokens !== undefined) {
							input = event.usage.input_tokens;
						}
						if (event.usage.cache_read_input_tokens !== undefined) {
							cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens !== undefined) {
							cacheWrite = event.usage.cache_creation_input_tokens;
						}
					}
					if (event.delta.stop_reason) {
						finishReason = mapStopReason(event.delta.stop_reason);
					}
					// 无缓存字段时 cacheRead/cacheWrite 保持 undefined，序列化时自然省略
					const usage: Usage = { input, output };
					if (cacheRead !== undefined) usage.cacheRead = cacheRead;
					if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
					yield { type: "usage", usage };
					break;
				}
				case "error":
					throw new LlmError(event.error.message, `stream_${event.error.type}`);
				default:
					// message_stop / ping：无需处理，finish 在流结束处统一产出
					break;
			}
		}

		if (finishReason === undefined) {
			// 未收到 message_delta 的 stop_reason 流就结束：视为截断，上层按错误处理
			throw new LlmError(
				"anthropic-messages: stream ended without stop_reason",
				"truncated_stream",
			);
		}
		yield { type: "finish", reason: finishReason };
	}

	return { api: "anthropic-messages", streamChat };
}
