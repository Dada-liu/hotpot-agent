// todo 工具（M4 Feature ①）：worker/task 的任务清单管理。
// 语义为全量替换：入参即当前完整清单（空数组 = 清空），模型每次调用都给出全部任务项；
// execute 校验后 append 一条 todo/set 事件落盘（agentId 取 ctx.agentId，last-write-wins
// fold 的归属依据），返回渲染后的清单文本供模型在下一步自检进度。
// 只读写会话日志，无文件副作用，isConcurrencySafe 为 true。

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TodoItem } from "../session/events.ts";
import type { ToolDefinition } from "./tool.ts";

const todoItemSchema = z.object({
	content: z.string().min(1),
	status: z.enum(["pending", "in_progress", "completed"]),
});

type TodoArgs = { todos: TodoItem[] };

// 清单渲染：与 orchestrator prompts.ts 的 todos 段同款 `- [status] content` 行格式
function renderTodos(todos: TodoItem[]): string {
	return todos.map((t) => `- [${t.status}] ${t.content}`).join("\n");
}

export const todoTool: ToolDefinition<TodoArgs> = {
	name: "todo",
	description:
		"Manage your task list. The input replaces the current list entirely — always provide the full list of tasks with their statuses, and call this tool again whenever you start or complete a task.",
	parameters: z.object({
		todos: z
			.array(todoItemSchema)
			.describe(
				"the complete task list; each item has a non-empty content and a status of pending, in_progress or completed. An empty array clears the list.",
			),
	}),
	// 只追加会话日志，同批并发安全
	isConcurrencySafe: true,
	async execute(args, ctx) {
		await ctx.session.append({
			type: "todo/set",
			id: randomUUID(),
			ts: new Date().toISOString(),
			agentId: ctx.agentId,
			todos: args.todos,
		});
		return { content: renderTodos(args.todos) };
	},
};
