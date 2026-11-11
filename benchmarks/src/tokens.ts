// token 分解：按模型档位累加 usage，便于报告做成本归因。
// 会话日志里每条 assistant_msg 都带 tier（main 依次选档，worker/task 按难度路由），
// 所以「这次跑批的钱花在哪个档位」是可直接折叠出来的事实，不需要额外埋点。

import type { ModelTier } from "@hotpot/core";

export interface TierTokens {
	high: { input: number; output: number };
	medium: { input: number; output: number };
	low: { input: number; output: number };
}

export function createTierTokens(): TierTokens {
	return {
		high: { input: 0, output: 0 },
		medium: { input: 0, output: 0 },
		low: { input: 0, output: 0 },
	};
}

export function addTierUsage(
	target: TierTokens,
	tier: ModelTier,
	usage: { input: number; output: number },
): void {
	target[tier].input += usage.input;
	target[tier].output += usage.output;
}

export function mergeTierTokens(
	into: TierTokens,
	from: TierTokens | undefined,
): void {
	if (from === undefined) {
		return;
	}
	for (const tier of ["high", "medium", "low"] as const) {
		into[tier].input += from[tier].input;
		into[tier].output += from[tier].output;
	}
}

export function tierTokensTotal(tokens: TierTokens): {
	input: number;
	output: number;
} {
	let input = 0;
	let output = 0;
	for (const tier of ["high", "medium", "low"] as const) {
		input += tokens[tier].input;
		output += tokens[tier].output;
	}
	return { input, output };
}
