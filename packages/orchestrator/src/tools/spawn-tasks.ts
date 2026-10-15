// spawn_tasks 元工具：worker 的并行拆分入口（03 文档 §4 三条件由 worker 提示词约束）。
// 每个 task spawn（role=task、parentAgentId=调用方 worker、档位继承 worker）后内联跑完
// 整个 turn；并发池按「取 N 个 → Promise.all → 取下一批」分批，N = runtime.maxParallelTasks。
// 每个任务结果独立成段：turn 中途 abort 标 `[FAILED] ${agentId}: aborted`；
// runTurn 出 error 事件或收尾 summary 缺失标 `[FAILED] ${agentId}: ${reason}`；
// 失败段原样进聚合 content、整体 isError=false —— 重试/接手/上报由 worker LLM 决定
// （验收 #5 只要求失败不静默丢失）。signal 为 runMainTurn 贯穿下来的同一个，cancel 时
// 各任务 turn 一并中止（Review Focus #4）。

import { randomUUID } from "node:crypto";
import type { ModelTier, ToolContext, ToolDefinition } from "@hotpot/core";
import { z } from "zod";
import type { OrchestrationRuntime } from "../runtime.ts";
import { runAgentInline } from "./run-worker.ts";

export interface SpawnTaskItem {
	task: string;
	context?: string;
	acceptance?: string;
}

export interface SpawnTasksArgs {
	tasks: SpawnTaskItem[];
}

// 单个 task 的完整生命周期：spawn 落盘 → user_msg 落盘（context/acceptance 折进描述）
// → 内联 turn → 结果段（失败按 `[FAILED] ${agentId}: ${reason}` 标注）
async function runTaskSection(
	runtime: OrchestrationRuntime,
	worker: { agentId: string; tier: ModelTier },
	item: SpawnTaskItem,
	signal: AbortSignal,
): Promise<string> {
	const { agentId } = await runtime.spawn({
		role: "task",
		parentAgentId: worker.agentId,
		task: item.task,
		tier: worker.tier,
	});
	const content = [item.task];
	if (item.context !== undefined) {
		content.push(`Context: ${item.context}`);
	}
	if (item.acceptance !== undefined) {
		content.push(`Acceptance criteria: ${item.acceptance}`);
	}
	await runtime.session.append({
		type: "user_msg",
		id: randomUUID(),
		ts: new Date().toISOString(),
		agentId,
		content: content.join("\n\n"),
	});
	const outcome = await runAgentInline(
		runtime,
		agentId,
		"task",
		worker.tier,
		signal,
	);
	if (outcome.aborted) {
		return `[FAILED] ${agentId}: aborted`;
	}
	if (outcome.failures.length > 0) {
		return `[FAILED] ${agentId}: ${outcome.failures.join("; ")}`;
	}
	if (outcome.summary === undefined) {
		return `[FAILED] ${agentId}: no assistant text produced`;
	}
	return `Task ${agentId} result:\n${outcome.summary}`;
}

export function createSpawnTasksTool(
	runtime: OrchestrationRuntime,
	worker: { agentId: string; tier: ModelTier },
): ToolDefinition<SpawnTasksArgs> {
	return {
		name: "spawn_tasks",
		description:
			"Split your task into atomic subtasks and dispatch them as parallel task agents. " +
			"Each subtask spawns one task agent (inheriting your model tier) that runs to " +
			"completion; per-task results are aggregated back to you. Failed subtasks appear " +
			"as [FAILED] sections in the aggregated result — decide whether to retry, take " +
			"over, or escalate. Only split when the parallel split rules hold: no write " +
			"conflicts, no sequential dependencies, each subtask independently complete.",
		parameters: z.object({
			tasks: z
				.array(
					z.object({
						task: z
							.string()
							.describe(
								"the full, self-contained atomic subtask handed to the task agent",
							),
						context: z
							.string()
							.optional()
							.describe("extra context appended to the subtask description"),
						acceptance: z
							.string()
							.optional()
							.describe("done-criterion the task agent must satisfy"),
					}),
				)
				.describe("atomic subtasks to spawn and run in parallel"),
		}),
		// 有派生副作用且内联跑多个完整 task turn，绝不能与同批工具并行
		isConcurrencySafe: false,
		async execute(args, ctx: ToolContext) {
			if (args.tasks.length === 0) {
				return { content: "No tasks provided: pass at least one subtask." };
			}
			// 「取 N 个 → Promise.all → 取下一批」批式并发池；任务 turn 的异常已在
			// runAgentInline 内兜底为结果段，池本身不抛（isError 恒 false）
			const cap = Math.max(1, runtime.maxParallelTasks);
			const sections: string[] = [];
			for (let i = 0; i < args.tasks.length; i += cap) {
				const batch = args.tasks.slice(i, i + cap);
				const results = await Promise.all(
					batch.map((item) =>
						runTaskSection(runtime, worker, item, ctx.signal),
					),
				);
				sections.push(...results);
			}
			return { content: sections.join("\n\n") };
		},
	};
}
