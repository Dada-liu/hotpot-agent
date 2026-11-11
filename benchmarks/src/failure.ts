// 失败分类：把「一句被截断的自由文本」变成可跨跑批聚合的枚举。
// 这是 P1「可诊断」的最小基础——服务端只认枚举，不接受自由文本。
// 判定顺序即优先级：官方 harness 的结论 > agent 自身的结论 > 校验命令的结论。
// 纯函数、无 IO：谁拿到结果谁分类，报告与遥测共用同一份判断，避免两边口径漂移。

import type { BenchmarkFailureClass } from "@hotpot/telemetry";

export type { BenchmarkFailureClass };

export interface FailureInput {
	passed: boolean;
	// agent 轮的结局；自建题 runner 不返回，缺省时退回文本判断
	agentOutcome?: "success" | "error" | "aborted";
	// 已脱敏的失败原因（report.ts 里就是这一份）
	reason?: string;
	// 官方 report 判定为空 patch；比文本匹配可靠，优先使用
	emptyPatch?: boolean;
}

// 上下文/输出上限：各家 provider 的措辞不同，统一归一成 max_tokens
const MAX_TOKENS_PATTERN =
	/max[_ ]?tokens|maximum context|context length|context window|length limit|too many tokens/i;

export function classifyFailure(
	input: FailureInput,
): BenchmarkFailureClass | undefined {
	if (input.passed) {
		return undefined;
	}
	if (input.emptyPatch === true) {
		return "empty_patch";
	}
	const reason = (input.reason ?? "").trim();
	const lower = reason.toLowerCase();

	if (lower === "empty patch" || lower === "empty_patch") {
		return "empty_patch";
	}
	if (input.agentOutcome === "aborted" || lower.startsWith("agent aborted")) {
		return "agent_aborted";
	}
	// 先判 max_tokens：它既可能表现为 agent error，也可能表现为跑完但被截断
	if (MAX_TOKENS_PATTERN.test(reason)) {
		return "max_tokens";
	}
	if (input.agentOutcome === "error" || lower.startsWith("agent error")) {
		return "agent_error";
	}
	if (lower.startsWith("validation timed out")) {
		return "timeout";
	}
	if (
		lower.startsWith("validation exited") ||
		lower.startsWith("validation stdout")
	) {
		return "validation_failed";
	}
	if (lower === "unresolved by official harness") {
		return "unresolved";
	}
	return "unknown";
}
