// 按角色装配工具注册表，规则钉死（docs/archive/03-agent-orchestration.md §1）：
// - main：只有编排元工具（Task 7 的 delegate/spawn_workers），不直接操作文件
// - worker：四个基础工具 + 元工具（元工具携带 spawn_tasks，可并行拆分）
// - task：只有四个基础工具，无派生能力（metaTools 直接忽略）
// 四件套与 createToolRegistry 复用 core 实现；metaTools 由上层注入，便于测试用桩替换。

import {
	bashTool,
	createToolRegistry,
	editTool,
	readTool,
	type ToolDefinition,
	type ToolRegistry,
	writeTool,
} from "@hotpot/core";
import type { AgentRole } from "./types.ts";

export function createRoleRegistry(
	role: AgentRole,
	metaTools: readonly ToolDefinition<unknown>[],
): ToolRegistry {
	const registry = createToolRegistry();
	if (role !== "main") {
		// worker / task 都有文件四件套；逐个 register 让泛型 T 各自推断，避免数组型变问题
		registry.register(bashTool);
		registry.register(readTool);
		registry.register(writeTool);
		registry.register(editTool);
	}
	if (role !== "task") {
		// main / worker 挂元工具；task 是底层，忽略任何派生能力
		for (const tool of metaTools) {
			registry.register(tool);
		}
	}
	return registry;
}
