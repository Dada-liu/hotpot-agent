// agent 循环的公开契约：LoopConfig 收拢 runTurn 的全部入参，AgentEvent 是产出给 UI 的事件流元素

import type { FinishReason, LlmAdapter, LlmError, ModelInfo } from "@hotpot/ai";
import type { ApprovalChain } from "../approval/chain.ts";
import type { HookChain } from "../hooks/hooks.ts";
import type { ModelTier } from "../session/events.ts";
import type { Session } from "../session/store.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolOutput } from "../tools/tool.ts";

// system 缺省时由 runTurn 用默认 section 注册表（buildSystemPrompt + registerDefaultSections）组装
export interface LoopConfig {
	session: Session;
	agentId: string;
	adapter: LlmAdapter;
	model: ModelInfo;
	apiKey: string;
	baseUrl?: string;
	registry: ToolRegistry;
	approval: ApprovalChain;
	cwd: string;
	system?: string;
	// assistant_msg 落盘的档位；缺省 "high"（M1 主 agent 语义，M2 worker/task 按难度路由）
	tier?: ModelTier;
	// step 边界注入钩子（M2 steer/queue）：每个 step 顶部调用一次，
	// 返回的字符串逐条落盘为 user_msg（agentId = cfg.agentId）后进入模型历史；缺省不轮询
	pollInbox?: () => Promise<string[]>;
	// 生命周期钩子链（M4 hooks）：pre_tool 在工具执行前、post_tool 在执行后（含失败）触发；
	// session_start/turn_end 由装配层与回合包装层触发。缺省不挂钩子
	hooks?: HookChain;
}

export type AgentEvent =
	| { type: "text"; delta: string }
	| { type: "tool_call"; name: string; input: unknown }
	| { type: "tool_result"; name: string; output: ToolOutput }
	| { type: "done"; stopReason: FinishReason }
	| { type: "error"; error: LlmError };
