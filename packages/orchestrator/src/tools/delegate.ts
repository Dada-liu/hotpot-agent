// delegate 元工具：主 agent 的难度判定与派发入口，execute 内联完成编排。
// 三个难度分支：trivial 只返回「直接回答」提示；simple 派一个 worker 并复用
// run-worker 的内联执行跑完它的整个 turn（worker 事件不外传，M2 计划决定 #3），
// 回收最后一条 assistant_msg 文本作为摘要回传；complex 只记录状态（phase 转 planning），
// main 随后在同一轮产出计划正文，plan 流程由 plan.ts 的 runPlanPhase 接管审批。
// 重复调用由 TurnState.lastDelegate 守卫：首次判定后即视为已消费（含 trivial），
// 再调用返回 isError。worker 不复用 main 的适配器：走 runtime.resolveModel(modelTier)
// 解析 worker 自己的档位模型与凭证；spawn 的 parentAgentId 固定 "main"（包级约定）。

import { randomUUID } from "node:crypto";
import type { ModelTier, ToolContext, ToolDefinition } from "@hotpot/core";
import { z } from "zod";
import type { OrchestrationRuntime } from "../runtime.ts";
import { runWorkerInline } from "./run-worker.ts";

export interface DelegateArgs {
	difficulty: "trivial" | "simple" | "complex";
	modelTier: ModelTier;
	task: string;
	reason?: string;
}

export interface TurnState {
	phase: "initial" | "planning" | "executing";
	planApproved: boolean;
	revisions: number;
	lastDelegate?: DelegateArgs;
}

export function createDelegateTool(
	runtime: OrchestrationRuntime,
	state: TurnState,
): ToolDefinition<DelegateArgs> {
	return {
		name: "delegate",
		description:
			"Assess the difficulty of the user's task and route the work accordingly. " +
			"trivial: pure Q&A, answer directly in your next message. " +
			"simple: dispatch exactly one worker agent to run the task to completion with its tools; " +
			"choose its model tier together with the difficulty call. " +
			"complex: a plan will be drafted and awaits user approval before any execution. " +
			"Call exactly once per user message, as the first action.",
		parameters: z.object({
			difficulty: z
				.enum(["trivial", "simple", "complex"])
				.describe("difficulty classification of the user's task"),
			modelTier: z
				.enum(["high", "medium", "low"])
				.describe(
					"model tier for the worker agent (simple) or the plan phase (complex)",
				),
			task: z
				.string()
				.describe(
					"the full, self-contained task description handed to the worker",
				),
			reason: z
				.string()
				.optional()
				.describe(
					"one-sentence justification for the difficulty classification",
				),
		}),
		// 有派生副作用且内联跑完整 worker turn，绝不能与同批工具并行
		isConcurrencySafe: false,
		async execute(args, ctx: ToolContext) {
			if (state.lastDelegate !== undefined) {
				return {
					content: `已判定（difficulty=${state.lastDelegate.difficulty}），勿重复调用 delegate`,
					isError: true,
				};
			}
			state.lastDelegate = args;
			if (args.difficulty === "trivial") {
				return { content: "难度为 trivial：无需派生 worker，直接回答用户。" };
			}
			if (args.difficulty === "complex") {
				state.phase = "planning";
				return {
					content:
						"difficulty=complex: produce the full plan (steps, files involved, " +
						"acceptance criteria) as your final message now. The approval step " +
						"follows automatically; do not ask for confirmation in prose.",
				};
			}
			state.phase = "executing";
			const { agentId } = await runtime.spawn({
				role: "worker",
				parentAgentId: "main",
				task: args.task,
				tier: args.modelTier,
			});
			// 任务描述作为 worker 的 user_msg 落盘：derive 按 agentId 过滤，main 的历史不受影响
			await runtime.session.append({
				type: "user_msg",
				id: randomUUID(),
				ts: new Date().toISOString(),
				agentId,
				content: args.task,
			});
			const summary = await runWorkerInline(
				runtime,
				agentId,
				args.modelTier,
				ctx.signal,
			);
			return {
				content: `Worker ${agentId} (tier=${args.modelTier}) result:\n${summary}`,
			};
		},
	};
}
