// 与 LLM 协议无关的统一类型契约：packages/core、packages/cli 与各协议适配器只消费本文件导出的名字

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			toolCallId: string;
			content: string;
			isError: boolean;
	  };

// tool_result 统一以 role:"user" 消息承载（Anthropic 原生如此；OpenAI 适配器负责转换 tool 消息）
export type Message = { role: "user" | "assistant"; content: ContentBlock[] };

// parameters 为 JSON Schema 对象，由各适配器原样转发给上游 API
export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export type Usage = {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
};

export type FinishReason =
	| "stop"
	| "tool_calls"
	| "max_tokens"
	| "aborted"
	| "error";

export type StreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_delta"; id: string; inputDelta: string }
	| { type: "tool_call_end"; id: string }
	| { type: "usage"; usage: Usage }
	| { type: "finish"; reason: FinishReason };

// 统一错误类型：code 为机器可读错误码；status / retryAfter 来自 HTTP 层（如有）
export class LlmError extends Error {
	code: string;
	status?: number;
	retryAfter?: number;

	constructor(
		message: string,
		code: string,
		options?: { status?: number; retryAfter?: number },
	) {
		super(message);
		this.name = "LlmError";
		this.code = code;
		this.status = options?.status;
		this.retryAfter = options?.retryAfter;
	}
}

// cost 单位：美元 / 百万 token
export interface ModelInfo {
	id: string;
	provider: string;
	api: "anthropic-messages" | "openai-completions";
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number };
}

export interface ChatRequest {
	model: ModelInfo;
	apiKey: string;
	baseUrl?: string;
	system: string;
	messages: Message[];
	tools: ToolDeclaration[];
}

export interface LlmAdapter {
	api: string;
	streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

// fetch 注入点：测试注入 fake 实现，保证不触碰真实网络
export type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	headers: Headers;
	body: ReadableStream<Uint8Array> | null;
}>;
