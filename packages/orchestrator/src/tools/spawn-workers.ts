// spawn_workers 元工具：complex 流 plan 获批后由 main 调用，按参数逐个 spawn worker 并内联跑完。
// 守卫：state.planApproved === false 直接 isError —— plan 未批准前不允许任何执行（编排文档 §3）。
// 每个 worker role=worker、档位取参数 modelTier，任务描述折进 worker 的 user_msg（context 追加在后）；
// worker 顺序内联执行（M2 保持简单正确，并行拆分是 Task 9 spawn_tasks 的职责），
// 聚合各 worker 摘要（复用 delegate simple 分支的 runWorkerInline）回传 main。

import { randomUUID } from "node:crypto";
import type { ModelTier, ToolContext, ToolDefinition } from "@hotpot/core";
import { z } from "zod";
import type { OrchestrationRuntime } from "../runtime/runtime.ts";
import type { TurnState } from "./delegate.ts";
import { runWorkerInline } from "./run-worker.ts";

export interface SpawnWorkersArgs {
	workers: { task: string; context?: string; modelTier: ModelTier }[];
}

export function createSpawnWorkersTool(
	runtime: OrchestrationRuntime,
	state: TurnState,
): ToolDefinition<SpawnWorkersArgs> {
	return {
		name: "spawn_workers",
		description:
			"Spawn worker agents to execute the approved plan. Each worker receives one " +
			"self-contained task with its own model tier and runs to completion; results are " +
			"aggregated back to you. Only available after the plan has been approved.",
		parameters: z.object({
			workers: z
				.array(
					z.object({
						task: z
							.string()
							.describe(
								"the full, self-contained task description handed to the worker",
							),
						context: z
							.string()
							.optional()
							.describe("extra context appended to the worker's task"),
						modelTier: z
							.enum(["high", "medium", "low"])
							.describe("model tier for this worker agent"),
					}),
				)
				.describe("worker agents to spawn and run sequentially"),
		}),
		// 有派生副作用且内联跑多个完整 worker turn，绝不能与同批工具并行
		isConcurrencySafe: false,
		async execute(args, ctx: ToolContext) {
			if (state.planApproved === false) {
				return {
					content:
						"Plan not approved yet: spawn_workers is only available after plan approval.",
					isError: true,
				};
			}
			const summaries: string[] = [];
			for (const worker of args.workers) {
				// parentAgentId 固定 "main"：主agent 的 agentId 是包级约定（与 delegate 一致）
				const { agentId } = await runtime.spawn({
					role: "worker",
					parentAgentId: "main",
					task: worker.task,
					tier: worker.modelTier,
				});
				// 任务描述作为 worker 的 user_msg 落盘：derive 按 agentId 过滤，main 的历史不受影响
				const content =
					worker.context === undefined
						? worker.task
						: `${worker.task}\n\nContext: ${worker.context}`;
				await runtime.session.append({
					type: "user_msg",
					id: randomUUID(),
					ts: new Date().toISOString(),
					agentId,
					content,
				});
				const summary = await runWorkerInline(
					runtime,
					agentId,
					worker.modelTier,
					ctx.signal,
				);
				summaries.push(
					`Worker ${agentId} (tier=${worker.modelTier}) result:\n${summary}`,
				);
			}
			return { content: summaries.join("\n\n") };
		},
	};
}
