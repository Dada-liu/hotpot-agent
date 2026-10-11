// OpenAI Chat Completions 协议适配器（同样覆盖 DeepSeek / Moonshot 等兼容端点）。
// 职责：统一 ChatRequest → /chat/completions 请求体；SSE 增量流 → 统一 StreamEvent。

import { parseSseStream } from "../sse.ts";
import {
	type ChatRequest,
	type FetchLike,
	type FinishReason,
	type LlmAdapter,
	LlmError,
	type StreamEvent,
	type ToolDeclaration,
} from "../types.ts";

// ---- 上行（请求）线格式 ----

type OaiToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

type OaiMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

// ---- 下行（响应 chunk）线格式 ----

type OaiChunk = {
	choices?: {
		index: number;
		delta?: {
			role?: string;
			content?: string | null;
			tool_calls?: {
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}[];
		};
		finish_reason?: string | null;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

// 统一 Message 数组 → OpenAI messages 线格式：
// system 提升为 messages 首条；assistant 的 tool_call 块转 tool_calls 数组；
// user 消息里的 tool_result 块逐条转为 role:"tool" 消息（OpenAI 原生形态），保持块间相对顺序
function toOaiMessages(req: ChatRequest): OaiMessage[] {
	const out: OaiMessage[] = [{ role: "system", content: req.system }];
	for (const msg of req.messages) {
		if (msg.role === "assistant") {
			let text = "";
			const toolCalls: OaiToolCall[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					text += block.text;
				} else if (block.type === "tool_call") {
					toolCalls.push({
						id: block.id,
						type: "function",
						function: {
							name: block.name,
							arguments: JSON.stringify(block.input),
						},
					});
				}
			}
			out.push({
				role: "assistant",
				// 纯工具调用消息按 OpenAI 约定 content 置 null
				content: text === "" && toolCalls.length > 0 ? null : text,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		} else {
			// user：连续 text 块合并为一条 user 消息；tool_result 块各占一条 tool 消息
			let text = "";
			const flushText = () => {
				if (text !== "") {
					out.push({ role: "user", content: text });
					text = "";
				}
			};
			for (const block of msg.content) {
				if (block.type === "tool_result") {
					flushText();
					out.push({
						role: "tool",
						tool_call_id: block.toolCallId,
						content: block.content,
					});
				} else if (block.type === "text") {
					text += block.text;
				}
			}
			flushText();
		}
	}
	return out;
}

function toOaiTool(tool: ToolDeclaration) {
	return {
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

// OpenAI finish_reason → 统一 FinishReason；length 表示 max_tokens，未知值（如 content_filter）归入 error
function mapFinishReason(raw: string): FinishReason {
	switch (raw) {
		case "stop":
			return "stop";
		case "tool_calls":
			return "tool_calls";
		case "length":
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

// 创建 OpenAI Chat Completions 适配器。fetchImpl 为注入点：测试传 fake，生产缺省用全局 fetch
export function createOpenAICompletionsAdapter(
	fetchImpl?: FetchLike,
): LlmAdapter {
	const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));

	async function* streamChat(
		req: ChatRequest,
		signal: AbortSignal,
	): AsyncIterable<StreamEvent> {
		// baseUrl 缺省走 OpenAI 官方端点；末尾斜杠归一化
		const baseUrl = (req.baseUrl ?? "https://api.openai.com/v1").replace(
			/\/+$/,
			"",
		);
		const res = await doFetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${req.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: req.model.id,
				stream: true,
				// 让末帧携带 usage，统一产出 usage 事件
				stream_options: { include_usage: true },
				max_tokens: req.model.maxTokens,
				messages: toOaiMessages(req),
				...(req.tools.length > 0 ? { tools: req.tools.map(toOaiTool) } : {}),
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
				"openai-completions: response body is null",
				"empty_response",
			);
		}

		// 进行中的 tool_call，按 OpenAI 的 index 跟踪：id/name 仅首帧携带，arguments 分帧到来
		const openToolCalls = new Map<number, { id: string; name: string }>();
		let finishReason: FinishReason | undefined;

		for await (const payload of parseSseStream(res.body)) {
			if (payload === "") continue;
			const chunk = JSON.parse(payload) as OaiChunk;
			if (chunk.usage) {
				yield {
					type: "usage",
					usage: {
						input: chunk.usage.prompt_tokens ?? 0,
						output: chunk.usage.completion_tokens ?? 0,
					},
				};
			}
			const choice = chunk.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta;
			if (delta?.content) yield { type: "text_delta", delta: delta.content };
			if (delta?.tool_calls) {
				for (const call of delta.tool_calls) {
					let open = openToolCalls.get(call.index);
					if (open === undefined) {
						open = { id: call.id ?? "", name: call.function?.name ?? "" };
						openToolCalls.set(call.index, open);
						yield { type: "tool_call_start", id: open.id, name: open.name };
					}
					const args = call.function?.arguments;
					if (args) {
						yield { type: "tool_call_delta", id: open.id, inputDelta: args };
					}
				}
			}
			// finish_reason 帧之后可能还有 usage 帧，finish 事件延迟到流结束统一产出
			if (choice.finish_reason) {
				finishReason = mapFinishReason(choice.finish_reason);
			}
		}

		if (finishReason === undefined) {
			// 未收到 finish_reason 流就结束：视为截断，上层按错误处理（半截 JSON 不得当成完整 tool call）
			throw new LlmError(
				"openai-completions: stream ended without finish_reason",
				"truncated_stream",
			);
		}
		for (const call of openToolCalls.values()) {
			yield { type: "tool_call_end", id: call.id };
		}
		yield { type: "finish", reason: finishReason };
	}

	return { api: "openai-completions", streamChat };
}
