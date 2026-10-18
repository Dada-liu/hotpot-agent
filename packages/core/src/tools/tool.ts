// 工具定义契约：泛型 T 与 zod schema 绑定（parameters: z.ZodType<T>），
// 框架在注册时擦除为 unknown 并在执行前用 schema.parse 校验入参。

import type { z } from "zod";
import type { ApprovalChain } from "../approval/chain.ts";
import type { Session } from "../session/store.ts";

export type ToolOutput = {
	content: string;
	isError?: boolean;
	details?: unknown;
};

// signal 用于中止执行；approval 供工具在执行中发起进一步审批；
// agentId/session 为 M4 新增：工具经 session.append 落盘功能事件（todo/set、skill/loaded 等）
// 并以 agentId 标记归属（与 tool_result 的归属语义一致）
export type ToolContext = {
	cwd: string;
	signal: AbortSignal;
	approval: ApprovalChain;
	agentId: string;
	session: Session;
};

export interface ToolDefinition<T> {
	name: string;
	description: string;
	parameters: z.ZodType<T>;
	timeoutMs?: number;
	isConcurrencySafe?: boolean;
	execute(args: T, ctx: ToolContext): Promise<ToolOutput>;
	// render 产出给模型看的文本；present 产出给人看的确认文本，均为可选
	render?(o: ToolOutput): string;
	present?(args: T, o: ToolOutput): string;
}
