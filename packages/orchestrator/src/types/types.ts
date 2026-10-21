// 编排层事件与角色类型。
// OrchestrationEvent 在 core AgentEvent 之上补充编排语义事件：agent_spawn 标记子 agent 诞生，
// plan 记录计划审批流的状态迁移（草稿/批准/拒绝/修订耗尽）。spawn 落盘的完整字段（id/ts/parentAgentId）
// 由 runtime 负责组装，这里的联合只描述编排层关心的形状。
// AgentRole 是编排层的严格角色联合；core 的 agent_spawn.role 是 string，
// 属于存储层的宽松契约，两者并不冲突（严格联合可赋值给 string）。

import type { AgentEvent, ModelTier } from "@hotpot/core";

// 三层 agent 角色：main（对话入口）、worker（执行/并行拆分）、task（原子子任务）
export type AgentRole = "main" | "worker" | "task";

// 一次 runMainTurn 回合内的主 agent 状态：首轮流路由（首轮检测计划草稿转
// planning）、plan 审批（planApproved/revisions）都记录在这里，随回合结束丢弃
export interface TurnState {
	phase: "initial" | "planning" | "executing";
	planApproved: boolean;
	revisions: number;
	/** 本回合扫描锚点：runMainTurn 落盘的 user_msg 事件 id。detectPlanDraft 以它为
	 * 窗口起点，防止 turn 内 steer 注入的 user_msg 把首轮计划挤出检测窗口 */
	turnAnchorId?: string;
}

export type OrchestrationEvent =
	| AgentEvent
	| {
			type: "agent_spawn";
			agentId: string;
			role: AgentRole;
			tier: ModelTier;
			task: string;
	  }
	| {
			type: "plan";
			phase: "drafted" | "approved" | "denied" | "revision_exhausted";
			plan?: string;
			// 作为计划草稿落盘的 main assistant_msg id：UI 隐藏正文气泡，只保留计划卡片
			messageIds?: string[];
	  };
