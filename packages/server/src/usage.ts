// usage 统计：从持久化事件流折叠 token 用量。
// 只累 assistant_msg.usage 的 input/output（cacheRead/cacheWrite 存在也不展示、不计入）；
// byTier 额外记 assistant_msg 条数 count，byAgent 按 agentId 聚合。

import type { SessionEvent } from "@hotpot/core";

export interface UsageBucket {
	input: number;
	output: number;
}

export interface TierUsage extends UsageBucket {
	// 该档位 assistant_msg 的条数
	count: number;
}

export interface UsageSummary {
	total: UsageBucket;
	byTier: Record<string, TierUsage>;
	byAgent: Record<string, UsageBucket>;
}

export function summarizeUsage(events: SessionEvent[]): UsageSummary {
	const total: UsageBucket = { input: 0, output: 0 };
	const byTier: Record<string, TierUsage> = {};
	const byAgent: Record<string, UsageBucket> = {};
	for (const e of events) {
		if (e.type !== "assistant_msg") continue;
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
	return { total, byTier, byAgent };
}
