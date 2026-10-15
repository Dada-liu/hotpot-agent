// 按角色装配工具注册表，规则钉死（docs/archive/03-agent-orchestration.md §1）：
// - main：只有编排元工具（delegate/spawn_workers），不直接操作文件
// - worker：四个基础工具 + 元工具（元工具携带 spawn_tasks，可并行拆分）
// - task：只有四个基础工具，无派生能力（metaTools 直接忽略）
// 四件套与 createToolRegistry 复用 core 实现；metaTools 由上层注入，便于测试用桩替换。
// worker 另有 createWorkerRegistry 工厂：元工具不是外部注入的桩，而是闭包绑定该
// worker（agentId/tier）的真实 spawn_tasks —— 派生的 task 以此 worker 为 parent、
// 继承其档位；delegate/spawn_workers/run-worker 内联 worker turn 一律走这个工厂，
// 嵌套 spawn_tasks 才可用。main/task 仍用 createRoleRegistry。

import {
	bashTool,
	createToolRegistry,
	editTool,
	type ModelTier,
	readTool,
	type ToolDefinition,
	type ToolRegistry,
	writeTool,
} from "@hotpot/core";
import type { OrchestrationRuntime, WorkerToolDecorator } from "./runtime.ts";
import { createSpawnTasksTool } from "./tools/spawn-tasks.ts";
import type { AgentRole } from "./types.ts";

// worker/task 的注册表把 decorate 应用到四件套（worker 另有 decorateWorkerTool 工厂，
// 元工具不装饰：delegate/spawn_workers/spawn_tasks 的审批语义由编排层自己负责）
export function createRoleRegistry(
	role: AgentRole,
	metaTools: readonly ToolDefinition<unknown>[],
	decorate?: WorkerToolDecorator,
): ToolRegistry {
	const registry = createToolRegistry();
	if (role !== "main") {
		// worker / task 都有文件四件套；逐个 register 让泛型 T 各自推断，避免数组型变问题
		for (const tool of [bashTool, readTool, writeTool, editTool]) {
			registry.register(decorate ? decorate(tool) : tool);
		}
	}
	if (role !== "task") {
		// main / worker 挂元工具；task 是底层，忽略任何派生能力
		for (const tool of metaTools) {
			registry.register(tool);
		}
	}
	return registry;
}

// worker 注册表工厂：四件套 + 绑定到该 worker 的 spawn_tasks（闭包携带 agentId/tier）
export function createWorkerRegistry(
	runtime: OrchestrationRuntime,
	worker: { agentId: string; tier: ModelTier },
): ToolRegistry {
	return createRoleRegistry(
		"worker",
		[createSpawnTasksTool(runtime, worker)],
		runtime.decorateWorkerTool,
	);
}
