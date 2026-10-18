// foldTodos：从事件日志重建某 agent 的当前 todo 清单。
// todo/set 携带全量列表快照，last-write-wins：只看指定 agentId 的事件，
// 最终生效的就是该 agent 最后一条 todo/set 的 todos 字段；
// 无记录返回空数组（上层据此决定 prompt 是否出 task-list 段）。
// 与 deriveMessages 的关系：todo/set 不进模型历史，清单状态由本 fold 纯函数重建。

import type { SessionEvent, TodoItem } from "./events.ts";

export function foldTodos(events: SessionEvent[], agentId: string): TodoItem[] {
	let todos: TodoItem[] = [];
	for (const event of events) {
		if (event.type === "todo/set" && event.agentId === agentId) {
			todos = event.todos;
		}
	}
	return todos;
}
