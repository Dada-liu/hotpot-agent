// 档位模型解析：ModelRef → ModelInfo + 协议适配器 + 凭证。
// 由 cli 的 resolveModelAdapter 迁移而来（orchestrator 成为编排层的统一解析入口）。
// 目录（@hotpot/ai 的 findModel）未命中时按 provider 名推断协议
// （anthropic→anthropic-messages，其余→openai-completions），并给出告警：
// contextWindow 等用保守默认值，定价记 0（未知即不可计费）。

import {
	createAnthropicMessagesAdapter,
	createOpenAICompletionsAdapter,
	findModel,
	type LlmAdapter,
	type ModelInfo,
} from "@hotpot/ai";

export interface ModelResolution {
	adapter: LlmAdapter;
	model: ModelInfo;
	apiKey: string;
	baseUrl?: string;
	// 目录未命中时的兜底告警文本；命中目录恒为 undefined
	warning?: string;
}

function createAdapter(api: ModelInfo["api"]): LlmAdapter {
	return api === "anthropic-messages"
		? createAnthropicMessagesAdapter()
		: createOpenAICompletionsAdapter();
}

export function resolveModel(ref: {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
}): ModelResolution {
	const known = findModel(ref.provider, ref.model);
	if (known) {
		return {
			adapter: createAdapter(known.api),
			model: known,
			apiKey: ref.apiKey,
			baseUrl: ref.baseUrl,
		};
	}
	const api =
		ref.provider === "anthropic" ? "anthropic-messages" : "openai-completions";
	return {
		adapter: createAdapter(api),
		model: {
			id: ref.model,
			provider: ref.provider,
			api,
			contextWindow: 128000,
			maxTokens: 8192,
			cost: { input: 0, output: 0 },
		},
		apiKey: ref.apiKey,
		baseUrl: ref.baseUrl,
		warning: `模型 "${ref.provider}/${ref.model}" 不在内置目录：按 provider 推断协议为 ${api}，contextWindow 取保守默认 128000`,
	};
}
