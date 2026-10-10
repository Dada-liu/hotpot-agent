// agent 循环的公开契约：LoopConfig 收拢 runTurn 的全部入参，AgentEvent 是产出给 UI 的事件流元素

import type { FinishReason, LlmAdapter, LlmError, ModelInfo } from "@hotpot/ai";
import type { ApprovalChain } from "../approval/chain.ts";
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
}

export type AgentEvent =
	| { type: "text"; delta: string }
	| { type: "tool_call"; name: string; input: unknown }
	| { type: "tool_result"; name: string; output: ToolOutput }
	| { type: "done"; stopReason: FinishReason }
	| { type: "error"; error: LlmError };
