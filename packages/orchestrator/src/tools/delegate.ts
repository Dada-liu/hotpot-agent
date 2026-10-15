// delegate 元工具：主 agent 的难度判定与派发入口，execute 内联完成编排。
// 三个难度分支：trivial 只返回「直接回答」提示；simple 派一个 worker 并在 execute 里
// 跑完它的整个 turn（worker 事件不外传，M2 计划决定 #3），回收最后一条 assistant_msg
// 文本作为摘要回传；complex 只记录状态（phase 转 planning），plan 流程由 Task 8 接管。
// 重复调用由 TurnState.phase 守卫：首次判定后 phase 离开 initial，再调用返回 isError。
// worker 不复用 main 的适配器：走 runtime.resolveModel(modelTier) 解析 worker 自己的
// 档位模型与凭证；spawn 的 parentAgentId 固定 "main"（主流 agentId 是包级约定）。

import { randomUUID } from "node:crypto";
import {
	type LoopConfig,
	loadSession,
	type ModelTier,
	runTurn,
	type ToolContext,
	type ToolDefinition,
} from "@hotpot/core";
import { z } from "zod";
import { buildRoleSystemPrompt } from "../prompts.ts";
import { createRoleRegistry } from "../registries.ts";
import type { OrchestrationRuntime } from "../runtime.ts";

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

// 读取 worker 最后一条 assistant_msg，拼接其文本块作为回传给 main 的摘要；
// 没有任何 assistant_msg 或文本块为空时返回 undefined，由调用方标注失败
async function readWorkerSummary(
	filePath: string,
	agentId: string,
): Promise<string | undefined> {
	const { events } = await loadSession(filePath);
	const messages = events.filter(
		(e) => e.type === "assistant_msg" && e.agentId === agentId,
	);
	const last = messages[messages.length - 1];
	if (last?.type !== "assistant_msg") return undefined;
	const text = last.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	return text === "" ? undefined : text;
}

// 内联跑完 worker 的整个 turn：任务已作为 user_msg 落盘，这里只组装 LoopConfig 并
// 耗尽 runTurn 的异步迭代。事件不外传，只收集 error 事件用于摘要标注（失败分类法 Task 9 细化）
async function runWorkerInline(
	runtime: OrchestrationRuntime,
	workerId: string,
	tier: ModelTier,
	signal: AbortSignal,
): Promise<string> {
	const registry = createRoleRegistry("worker", []);
	const resolved = runtime.resolveModel(tier);
	const cfg: LoopConfig = {
		session: runtime.session,
		agentId: workerId,
		adapter: resolved.adapter,
		model: resolved.model,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		registry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt("worker", {
			cwd: runtime.cwd,
			os: process.platform,
			date: new Date().toISOString().slice(0, 10),
			tools: registry.declarations(),
		}),
		tier,
	};
	const failures: string[] = [];
	for await (const event of runTurn(cfg, signal)) {
		if (event.type === "error") {
			failures.push(`${event.error.code}: ${event.error.message}`);
		}
	}
	const summary = await readWorkerSummary(runtime.session.filePath, workerId);
	if (failures.length > 0) {
		return `[${workerId} failed] ${failures.join("; ")}`;
	}
	return summary ?? `[${workerId} failed] no assistant text produced`;
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
			if (state.phase !== "initial") {
				return {
					content: `已判定（difficulty=${state.lastDelegate?.difficulty ?? "unknown"}），勿重复调用 delegate`,
					isError: true,
				};
			}
			state.lastDelegate = args;
			if (args.difficulty === "trivial") {
				return { content: "难度为 trivial：无需派生 worker，直接回答用户。" };
			}
			if (args.difficulty === "complex") {
				state.phase = "planning";
				return { content: "难度为 complex：生成 plan 并等待审批。" };
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
