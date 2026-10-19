import type { ModelInfo } from "./types.ts";

// M1 首批模型目录。数值取自各厂商官方定价 / 文档页，注释标注复核日期；cost 单位：美元 / 百万 token
export const MODELS: ModelInfo[] = [
	{
		// Anthropic 官方：200K 上下文、64K 最大输出，$3/$15（2025-09-29 发布价，2026-07 复核一致）
		id: "claude-sonnet-4-5",
		provider: "anthropic",
		api: "anthropic-messages",
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 3, output: 15 },
	},
	{
		// OpenAI 官方：1M 上下文（精确值 1047576）、32768 最大输出，$2/$8（2025-04 发布价，2026-10 复核一致）
		id: "gpt-4.1",
		provider: "openai",
		api: "openai-completions",
		contextWindow: 1_047_576,
		maxTokens: 32_768,
		cost: { input: 2, output: 8 },
	},
	{
		// DeepSeek 官方定价页（DeepSeek-V3.2，2025-09 生效，2026-02 复核一致）：128K 上下文、
		// 非思考模式最大输出 8K；输入取缓存未命中价 $0.28（缓存命中 $0.028 未计入），输出 $0.42
		id: "deepseek-chat",
		provider: "deepseek",
		api: "openai-completions",
		contextWindow: 131_072,
		maxTokens: 8_192,
		cost: { input: 0.28, output: 0.42 },
	},
	{
		// DeepSeek 官方定价页（2026-10-19 复核）非高峰人民币价：缓存未命中输入 ¥1/M、输出 ¥4/M；
		// 高峰翻倍为 ¥2/¥8。按 7.1 CNY/USD 折算为 $0.14/$0.56（非高峰）；
		// contextWindow/maxTokens 沿用 DeepSeek 现有 128K/8K 规格（官方 V4 文档未另行明示）
		id: "deepseek-flash",
		provider: "deepseek",
		api: "openai-completions",
		contextWindow: 131_072,
		maxTokens: 8_192,
		cost: { input: 0.14, output: 0.56 },
	},
	{
		// DeepSeek 官方定价页（2026-10-19 复核）非高峰人民币价：缓存未命中输入 ¥4.5/M、输出 ¥13.5/M；
		// 高峰 ¥9/¥27。按 7.1 CNY/USD 折算为 $0.63/$1.90（非高峰）；
		// contextWindow/maxTokens 沿用 DeepSeek 现有 128K/8K 规格
		id: "deepseek-v4-pro",
		provider: "deepseek",
		api: "openai-completions",
		contextWindow: 131_072,
		maxTokens: 8_192,
		cost: { input: 0.63, output: 1.9 },
	},
	{
		// deepseek-v4-flash 按 Flash 计费：官方人民币价与 deepseek-flash 相同（¥1/¥4 非高峰，高峰翻倍）；
		// 按 7.1 CNY/USD 折算为 $0.14/$0.56（非高峰）
		id: "deepseek-v4-flash",
		provider: "deepseek",
		api: "openai-completions",
		contextWindow: 131_072,
		maxTokens: 8_192,
		cost: { input: 0.14, output: 0.56 },
	},
	{
		// Moonshot 官方海外定价：$0.60/$2.50（2026-06 第三方复核约 $0.57/$2.30，以官方为准）；
		// 128K 上下文；maxTokens 官方未明示，取第三方聚合值 16384（2026-10 复核，待官方文档确认）
		id: "kimi-k2",
		provider: "moonshot",
		api: "openai-completions",
		contextWindow: 131_072,
		maxTokens: 16_384,
		cost: { input: 0.6, output: 2.5 },
	},
];

export function findModel(provider: string, id: string): ModelInfo | undefined {
	return MODELS.find((model) => model.provider === provider && model.id === id);
}
