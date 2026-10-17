// 与服务端 wire.ts 的契约镜像，改动需双侧同步。
// 本包不依赖 @hotpot/core（避免把 node 包拖进 vite 解析），
// 这里只镜像 UI 需要的字段子集，结构上与 server/src/wire.ts 保持一致。

// 消息内容块（core ContentBlock 的子集：文本与工具调用；
// tool_result 块不落会话事件，结果走 tool_result 事件按 toolCallId 配对）
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; input: unknown };

// 会话事件（SessionEvent 联合的镜像子集）
export type SessionEvent =
	// meta 是文件首行，无 id/ts
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
			// server 侧恒有 usage；镜像为可选以兼容历史日志与测试构造
			usage?: { input: number; output: number };
	  }
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
			tier: string;
	  }
	| {
			type: "approval/asked";
			id: string;
			ts: string;
			agentId: string;
			payload: Record<string, unknown>;
	  }
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
			queue: "next-turn" | "next-step";
			messages: { id: string; content: string }[];
	  }
	| {
			type: "error";
			id: string;
			ts: string;
			agentId: string;
			code: string;
			message: string;
	  };

// 与服务端 wire.ts 的契约镜像，改动需双侧同步（事件定义逐字段照抄）
export type WireEvent =
	| { seq: number; kind: "log"; event: SessionEvent }
	| { seq: number; kind: "delta"; agentId: string; text: string }
	| {
			seq: number;
			kind: "turn";
			phase: "start" | "end";
			stopReason?: string;
			error?: string;
	  }
	| {
			seq: number;
			kind: "plan";
			phase: "drafted" | "approved" | "denied" | "revision_exhausted";
			plan?: string;
	  }
	| {
			seq: number;
			kind: "spawn";
			agentId: string;
			role: "worker" | "task";
			tier: string;
			task: string;
			parentAgentId: string;
	  }
	| {
			seq: number;
			kind: "approval";
			requestId: string;
			approvalType: "tool" | "plan";
			summary: string;
			detail?: string;
			plan?: string;
	  };
