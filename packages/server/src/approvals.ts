// 审批桥：把 core/orchestrator 的审批询问转成 UI 协议里的 approval 事件 + parked promise。
// 语义：registerToolAsk/registerPlanAsk 先创建 requestId 与 parked promise 入 pending 表，
// 再经注入的 notify 回调广播 approval 事件（由调用方接到 wire hub 的 emit），
// 最后返回 promise 挂起等待 UI 应答；answer 按 requestId resolve，未命中（或类型不符）
// 返回 false。requestId 即会话日志里 approval/asked 的 durable id（由审计包装层透传），
// 广播/应答/落盘 decided 共用同一 id。

import { randomUUID } from "node:crypto";
import type { PlanDecision } from "@hotpot/orchestrator";

export type ToolApprovalDecision = "allow" | "deny";

// notify 的 payload：tool 询问带 summary/detail；plan 询问带 plan 全文与摘要
export type ApprovalNotifyPayload =
	| { approvalType: "tool"; summary: string; detail?: string }
	| { approvalType: "plan"; summary: string; plan: string };

export type ApprovalNotifier = (
	requestId: string,
	payload: ApprovalNotifyPayload,
) => void;

type PendingEntry =
	| { type: "tool"; resolve: (d: ToolApprovalDecision) => void }
	| { type: "plan"; resolve: (d: PlanDecision) => void };

export interface ApprovalBridge {
	// 登记一次工具审批询问：入 pending 表 → 广播 → 返回 parked promise
	registerToolAsk(req: {
		kind: "command" | "write";
		summary: string;
		detail: string;
	}): Promise<ToolApprovalDecision>;
	// 登记一次 plan 审批询问（complex 流的 onPlanApproval 入口）
	registerPlanAsk(plan: string): Promise<PlanDecision>;
	// 按 requestId 应答：命中则 resolve 并返回 true；未命中或类型不符返回 false
	answer(
		requestId: string,
		decision: ToolApprovalDecision | PlanDecision,
	): boolean;
	// 应答当前挂起的 plan 询问（每会话同一时刻至多一个：plan 阶段随 turn 串行）；
	// 无挂起返回 false
	answerPendingPlan(decision: PlanDecision): boolean;
	// 当前挂起中的请求（id 列表），供状态查询
	pending(): string[];
}

function planSummary(plan: string): string {
	const firstLine = plan
		.split("\n")
		.map((s) => s.trim())
		.find((s) => s !== "");
	const text = firstLine ?? "Plan approval requested";
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export function createApprovalBridge(notify: ApprovalNotifier): ApprovalBridge {
	const pendingMap = new Map<string, PendingEntry>();

	return {
		registerToolAsk(req: {
			kind: "command" | "write";
			summary: string;
			detail: string;
			requestId?: string;
		}): Promise<ToolApprovalDecision> {
			// 审计包装层已透传 asked 的 durable id 时直接采用，与落盘 decided 共用同一 id；
			// 缺省（如纯内存链）才自行生成
			const requestId = req.requestId ?? randomUUID();
			const promise = new Promise<ToolApprovalDecision>((resolve) => {
				pendingMap.set(requestId, { type: "tool", resolve });
			});
			notify(requestId, {
				approvalType: "tool",
				summary: req.summary,
				detail: req.detail,
			});
			return promise;
		},

		registerPlanAsk(plan: string): Promise<PlanDecision> {
			const requestId = randomUUID();
			const promise = new Promise<PlanDecision>((resolve) => {
				pendingMap.set(requestId, { type: "plan", resolve });
			});
			notify(requestId, {
				approvalType: "plan",
				summary: planSummary(plan),
				plan,
			});
			return promise;
		},

		answer(
			requestId: string,
			decision: ToolApprovalDecision | PlanDecision,
		): boolean {
			const entry = pendingMap.get(requestId);
			if (entry === undefined) return false;
			if (entry.type === "tool") {
				if (decision !== "allow" && decision !== "deny") return false;
				pendingMap.delete(requestId);
				entry.resolve(decision);
				return true;
			}
			if (typeof decision === "string") return false;
			pendingMap.delete(requestId);
			entry.resolve(decision);
			return true;
		},

		pending(): string[] {
			return [...pendingMap.keys()];
		},

		answerPendingPlan(decision: PlanDecision): boolean {
			for (const [requestId, entry] of pendingMap) {
				if (entry.type !== "plan") continue;
				pendingMap.delete(requestId);
				entry.resolve(decision);
				return true;
			}
			return false;
		},
	};
}
