// 会话事件类型（v1 定稿）：字段对齐 docs/archive/02-architecture.md 第 5 节
// M1 只写入 meta/user_msg/assistant_msg/tool_call/tool_result/error；
// M2 起 agent_spawn、approval/*、inbox/spliced 已由编排层（packages/orchestrator）产出。
// 文档第 5 节还列了 turn/start|turn/end 与 request_header，M1 暂不需要，未纳入本联合。

import type { ContentBlock, Usage } from "@hotpot/ai";

// 模型档位：主 agent 固定 high，worker/task 按难度路由（docs/archive/03-agent-orchestration.md 第 8 节）
export type ModelTier = "high" | "medium" | "low";

// steer 队列：next-turn 排队等 turn 结束，next-step 当前 step 结束即注入
export type InboxQueue = "next-turn" | "next-step";

// inbox/spliced 携带的排队消息；带 id 以便崩溃恢复后去重
export type InboxMessage = { id: string; content: string };

export type SessionEvent =
	// meta 是文件首行，无 id/ts；formatVersion 恒为 1，真出现 v2 需求时再加迁移
	| {
			type: "meta";
			sessionId: string;
			createdAt: string;
			cwd: string;
			formatVersion: 1;
	  }
	| {
			type: "user_msg";
			id: string;
			ts: string;
			agentId: string;
			content: string;
	  }
	| {
			type: "assistant_msg";
			id: string;
			ts: string;
			agentId: string;
			content: ContentBlock[];
			usage: Usage;
			model: string;
			tier: ModelTier;
	  }
	| {
			type: "tool_call";
			id: string;
			ts: string;
			agentId: string;
			name: string;
			input: unknown;
	  }
	// tool_result 通过 toolCallId 关联上游调用；agentId 标记结果归属（derive 按它过滤）。
	// 缺省 "main"：M1 旧日志的 tool_result 无此字段，视为主 agent 的结果（向后兼容）
	| {
			type: "tool_result";
			id: string;
			ts: string;
			agentId?: string;
			toolCallId: string;
			content: string;
			isError: boolean;
	  }
	| {
			type: "agent_spawn";
			id: string;
			ts: string;
			parentAgentId: string;
			agentId: string;
			role: string;
			task: string;
			tier: ModelTier;
	  }
	| {
			type: "approval/asked";
			id: string;
			ts: string;
			agentId: string;
			payload: Record<string, unknown>;
	  }
	// note 为可选审批备注（如拒绝理由）；audited 包装层不填，编排层 plan 流程自行 append 时使用
	| {
			type: "approval/decided";
			id: string;
			ts: string;
			requestId: string;
			decision: "approved" | "denied";
			note?: string;
	  }
	| {
			type: "inbox/spliced";
			id: string;
			ts: string;
			agentId: string;
			queue: InboxQueue;
			messages: InboxMessage[];
	  }
	| {
			type: "error";
			id: string;
			ts: string;
			agentId: string;
			code: string;
			message: string;
	  };
