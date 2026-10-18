// 按角色装配工具注册表，规则钉死（docs/archive/03-agent-orchestration.md §1）：
// - main：只有编排元工具（delegate/spawn_workers），不直接操作文件
// - worker：四个基础工具 + 元工具（元工具携带 spawn_tasks，可并行拆分）
// - task：只有四个基础工具，无派生能力（metaTools 直接忽略）
// 四件套与 createToolRegistry 复用 core 实现；metaTools 由上层注入，便于测试用桩替换。
// M4 起第一参为 OrchestrationRuntime：四件套的 decorate（runtime.decorateWorkerTool）
// 与 feature 派生的基础外工具（featureEnabled 开关 + runtime 透传字段）都经 runtime 判读；
// 装饰只作用于四件套，feature 外工具裸注册（Review Focus 1）。
// worker 另有 createWorkerRegistry 工厂：元工具不是外部注入的桩，而是闭包绑定该
// worker（agentId/tier）的真实 spawn_tasks —— 派生的 task 以此 worker 为 parent、
// 继承其档位；delegate/spawn_workers/run-worker 内联 worker turn 一律走这个工厂，
// 嵌套 spawn_tasks 才可用。main/task 仍用 createRoleRegistry。

import {
	bashTool,
	createToolRegistry,
	editTool,
	featureEnabled,
	type ModelTier,
	readTool,
	type ToolDefinition,
	type ToolRegistry,
	todoTool,
	writeTool,
} from "@hotpot/core";
import type { OrchestrationRuntime, WorkerToolDecorator } from "./runtime.ts";
import { createSpawnTasksTool } from "./tools/spawn-tasks.ts";
import type { AgentRole } from "./types.ts";

// feature 派生的基础外工具（worker/task 追加；main 永远只有元工具，不进这里）。
// 开关一律经 featureEnabled（`?? true` 缺省全开）；Task 2 已并入 todo（本任务）、
// Task 3 web_fetch、Task 4 web_search、Task 5 mcpTools（已并入，是后续任务的接入样板）。
// 返回的工具裸注册：不套 decorateWorkerTool（policy 包装只包四件套）
function featureDerivedTools(
	runtime: OrchestrationRuntime,
): ToolDefinition<unknown>[] {
	const tools: ToolDefinition<unknown>[] = [];
	if (featureEnabled(runtime.features, "todo")) {
		tools.push(todoTool);
	}
	if (featureEnabled(runtime.features, "mcp")) {
		tools.push(...(runtime.mcpTools ?? []));
	}
	return tools;
}

export function createRoleRegistry(
	runtime: OrchestrationRuntime,
	role: AgentRole,
	metaTools: readonly ToolDefinition<unknown>[],
): ToolRegistry {
	const registry = createToolRegistry();
	if (role !== "main") {
		// worker / task 都有文件四件套；逐个 register 让泛型 T 各自推断，避免数组型变问题。
		// decorate 只在这里作用于四件套
		const decorate: WorkerToolDecorator | undefined =
			runtime.decorateWorkerTool;
		for (const tool of [bashTool, readTool, writeTool, editTool]) {
			registry.register(decorate ? decorate(tool) : tool);
		}
		for (const tool of featureDerivedTools(runtime)) {
			registry.register(tool);
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
	return createRoleRegistry(runtime, "worker", [
		createSpawnTasksTool(runtime, worker),
	]);
}
