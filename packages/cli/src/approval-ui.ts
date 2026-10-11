// 终端审批 handler：展示 ApprovalRequest 的 summary/detail，读一行 y/n。
// fail-closed：空行、EOF、任何非 y/yes 的输入都视为 deny（默认 n）。

import type { ApprovalHandler } from "@hotpot/core";
import type { ChatInput, ChatOutput } from "./chat.ts";

export function createTerminalApproval(
	input: ChatInput,
	output: ChatOutput,
): ApprovalHandler {
	return async (req) => {
		output.write(`\n[approval] ${req.summary}\n`);
		if (req.detail !== "" && req.detail !== req.summary) {
			output.write(`${req.detail}\n`);
		}
		output.write("允许执行？[y/N] ");
		const answer = await input.readLine();
		const allow = answer !== null && /^(y|yes)$/i.test(answer.trim());
		output.write(allow ? "已允许\n" : "已拒绝\n");
		return allow ? "allow" : "deny";
	};
}
