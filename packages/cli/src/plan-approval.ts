// 终端 plan 审批 UI：complex 流起草 plan 后经 onPlanApproval 调起（chat.ts 注入）。
// 交互：打印 plan 全文 + 提示「批准输入 y，拒绝输入 n，批注直接输入内容回车」。
// 裁决映射：y/yes → approve；n/no → reject（note 为空串）；其他非空行 → annotate(note)；
// 空行/EOF → reject（fail-closed，与 command/write 审批的默认 deny 语义一致）。

import type { PlanDecision } from "@hotpot/orchestrator";
import type { ChatInput, ChatOutput } from "./chat.ts";

export function createTerminalPlanApproval(
	input: ChatInput,
	output: ChatOutput,
): (plan: string) => Promise<PlanDecision> {
	return async (plan: string): Promise<PlanDecision> => {
		output.write(`\n[plan] 待审批计划：\n${plan}\n`);
		output.write("批准输入 y，拒绝输入 n，批注直接输入内容回车：");
		const answer = await input.readLine();
		if (answer === null) {
			// EOF：fail-closed 拒绝
			return { kind: "reject", note: "" };
		}
		const line = answer.trim();
		if (/^(y|yes)$/i.test(line)) {
			return { kind: "approve" };
		}
		if (line === "" || /^(n|no)$/i.test(line)) {
			return { kind: "reject", note: "" };
		}
		return { kind: "annotate", note: line };
	};
}
