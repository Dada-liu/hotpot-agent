// 审批审计包装层：包一层现有 ApprovalChain，在 ask 前后把 asked/decided 事件落盘到会话日志
// 落盘顺序：先 append approval/asked（id=randomUUID，payload 含 kind/summary/detail）→ 委托 inner.ask
// → append approval/decided（requestId=asked.id，allow→approved / deny→denied）→ 返回 inner 的裁决
// chain.ts 保持纯逻辑不感知会话；note 字段留给编排层自行 append decided 时使用，本包装层不带

import { randomUUID } from "node:crypto";
import type { Session } from "../session/store.ts";
import {
	ApprovalChain,
	type ApprovalDecision,
	type ApprovalHandler,
	type ApprovalRequest,
} from "./chain.ts";

// ApprovalChain 含私有字段，对象字面量无法满足其结构类型，故用子类把 use/ask 全部委托给 inner
class AuditedApprovalChain extends ApprovalChain {
	private readonly inner: ApprovalChain;
	private readonly session: Session;
	private readonly agentId: string;

	constructor(
		inner: ApprovalChain,
		opts: { session: Session; agentId: string },
	) {
		super();
		this.inner = inner;
		this.session = opts.session;
		this.agentId = opts.agentId;
	}

	use(h: ApprovalHandler): void {
		this.inner.use(h);
	}

	async ask(req: ApprovalRequest): Promise<ApprovalDecision> {
		const asked = {
			type: "approval/asked" as const,
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId: this.agentId,
			payload: { kind: req.kind, summary: req.summary, detail: req.detail },
		};
		await this.session.append(asked);
		// 把 asked 的 durable id 透传为广播级 requestId，内外 id 统一：
		// 应答方按此 id 广播/受理，decided 落盘也经同一 id 关联
		const decision = await this.inner.ask({ ...req, requestId: asked.id });
		await this.session.append({
			type: "approval/decided",
			id: randomUUID(),
			ts: new Date().toISOString(),
			requestId: asked.id,
			decision: decision === "allow" ? "approved" : "denied",
		});
		return decision;
	}
}

// 包装现有 chain（不替换类）：返回的对象可直接当 ApprovalChain 使用
export function createAuditedApprovalChain(
	inner: ApprovalChain,
	opts: { session: Session; agentId: string },
): ApprovalChain {
	return new AuditedApprovalChain(inner, opts);
}
