// usage 统计：从持久化事件流折叠 token 用量与 M4 功能用量。
// token：只累 assistant_msg.usage 的 input/output（cacheRead/cacheWrite 存在也不展示、不计入）；
// byTier 额外记 assistant_msg 条数 count，byAgent 按 agentId 聚合。
// features（M4 验收「遥测能看到该功能的开关与用量」）：按事件类型与工具名计数，
// 开关取 settings.features（默认全开）。M5 报表直接消费该结构。

import { featureEnabled, type SessionEvent, type Settings } from "@hotpot/core";

export interface UsageBucket {
	input: number;
	output: number;
}

export interface TierUsage extends UsageBucket {
	// 该档位 assistant_msg 的条数
	count: number;
}

// 单功能用量：events = 该功能专属事件条数；toolCalls = 该功能工具被调用次数
export interface FeatureUsage {
	enabled: boolean;
	events: number;
	toolCalls: number;
}

export type FeatureKey =
	| "todo"
	| "hooks"
	| "skills"
	| "promptTemplates"
	| "webSearch"
	| "webFetch"
	| "mcp";

export type FeatureUsageSummary = Record<FeatureKey, FeatureUsage>;

export interface UsageSummary {
	total: UsageBucket;
	byTier: Record<string, TierUsage>;
	byAgent: Record<string, UsageBucket>;
	features: FeatureUsageSummary;
}

const FEATURE_KEYS: readonly FeatureKey[] = [
	"todo",
	"hooks",
	"skills",
	"promptTemplates",
	"webSearch",
	"webFetch",
	"mcp",
];

function emptyFeatureUsage(
	features: Settings["features"],
): FeatureUsageSummary {
	const out = {} as FeatureUsageSummary;
	for (const key of FEATURE_KEYS) {
		out[key] = {
			enabled: featureEnabled(features, key),
			events: 0,
			toolCalls: 0,
		};
	}
	return out;
}

// MCP 工具名为 mcp__<server>__<tool>；其余功能按固定工具名归属
function featureForTool(name: string): FeatureKey | undefined {
	if (name === "todo") return "todo";
	if (name === "web_search") return "webSearch";
	if (name === "web_fetch") return "webFetch";
	if (name.startsWith("mcp__")) return "mcp";
	return undefined;
}

function featureForEvent(event: SessionEvent): FeatureKey | undefined {
	switch (event.type) {
		case "todo/set":
			return "todo";
		case "hook/fired":
			return "hooks";
		case "skill/loaded":
			return "skills";
		case "prompt/invoked":
			return "promptTemplates";
		case "mcp/attached":
			return "mcp";
		default:
			return undefined;
	}
}

export function summarizeUsage(
	events: SessionEvent[],
	features?: Settings["features"],
): UsageSummary {
	const total: UsageBucket = { input: 0, output: 0 };
	const byTier: Record<string, TierUsage> = {};
	const byAgent: Record<string, UsageBucket> = {};
	const featureUsage = emptyFeatureUsage(features);
	for (const e of events) {
		const featureByEvent = featureForEvent(e);
		if (featureByEvent !== undefined) {
			featureUsage[featureByEvent].events += 1;
		}
		if (e.type === "tool_call") {
			// tool_call 事件与 assistant_msg.content 里的 tool_call 块是同一调用：
			// loop 目前不单独 append tool_call 事件（M1 契约保留），计数以 assistant_msg
			// 内容块为准（下方分支），避免双计
			continue;
		}
		if (e.type === "assistant_msg") {
			for (const block of e.content) {
				if (block.type !== "tool_call") continue;
				const feature = featureForTool(block.name);
				if (feature !== undefined) {
					featureUsage[feature].toolCalls += 1;
				}
			}
			const { input, output } = e.usage;
			total.input += input;
			total.output += output;
			const tier = byTier[e.tier] ?? { input: 0, output: 0, count: 0 };
			tier.input += input;
			tier.output += output;
			tier.count += 1;
			byTier[e.tier] = tier;
			const agent = byAgent[e.agentId] ?? { input: 0, output: 0 };
			agent.input += input;
			agent.output += output;
			byAgent[e.agentId] = agent;
		}
	}
	return { total, byTier, byAgent, features: featureUsage };
}
