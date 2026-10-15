// 编排层事件与角色类型。
// OrchestrationEvent 在 core AgentEvent 之上补充编排语义事件：agent_spawn 标记子 agent 诞生，
// plan 记录计划审批流的状态迁移（草稿/批准/拒绝/修订耗尽）。spawn 落盘的完整字段（id/ts/parentAgentId）
// 由 runtime 负责组装，这里的联合只描述编排层关心的形状。
// AgentRole 是编排层的严格角色联合；core 的 agent_spawn.role 是 string，
// 属于存储层的宽松契约，两者并不冲突（严格联合可赋值给 string）。

import type { AgentEvent, ModelTier } from "@hotpot/core";

// 三层 agent 角色：main（对话入口）、worker（执行/并行拆分）、task（原子子任务）
export type AgentRole = "main" | "worker" | "task";

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
	  };
