// 审批 waterfall：按注册顺序询问各 handler，任一返回 allow/deny 即短路；
// 全部返回 next（或未注册任何 handler）时默认 deny —— fail-closed，安全关键路径。
// 决策落 approval/asked、approval/decided 会话事件由上层（turn 循环）负责，这里只实现链。

export type ApprovalRequest = {
	kind: "command" | "write";
	summary: string;
	detail: string;
	// 可选广播级 id：审计包装层落盘 asked 后把自己的 durable id 透传进来，
	// 使广播/应答与落盘审计共用同一 id（缺省时由应答方自行生成）
	requestId?: string;
};

export type ApprovalDecision = "allow" | "deny";

// 返回 "next" 表示本 handler 不裁决，交给下一个 handler
export type ApprovalHandler = (
	req: ApprovalRequest,
) => Promise<ApprovalDecision | "next">;

export class ApprovalChain {
	private handlers: ApprovalHandler[] = [];

	use(h: ApprovalHandler): void {
		this.handlers.push(h);
	}

	// 顺序询问；无 handler 给出终局裁决时 fail-closed 返回 deny
	async ask(req: ApprovalRequest): Promise<ApprovalDecision> {
		for (const h of this.handlers) {
			const decision = await h(req);
			if (decision === "allow" || decision === "deny") {
				return decision;
			}
		}
		return "deny";
	}
}
