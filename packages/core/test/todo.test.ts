// todo 工具与 foldTodos 测试：
// - 全量替换语义：todoTool.execute 入参即全量清单，append 一条 todo/set 快照并返回渲染文本
// - 事件落盘：todo/set 字段完整（id/ts/agentId/todos），agentId 取 ctx.agentId
// - fold 恢复：last-write-wins、只认指定 agentId、无记录返回空数组
// - schema 校验：status 枚举、content 非空（registry 层 parse 拒绝非法入参）

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApprovalChain } from "../src/approval/chain.ts";
import type { SessionEvent, TodoItem } from "../src/session/events.ts";
import { foldTodos } from "../src/session/todos.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { todoTool } from "../src/tools/todo.ts";
import type { ToolContext } from "../src/tools/tool.ts";

// 捕获 append 的会话桩：断言落盘事件而不触盘
function captureSession(events: SessionEvent[]) {
	return {
		id: "test-session",
		filePath: "/tmp/test-session.jsonl",
		append: async (e: SessionEvent) => {
			events.push(e);
		},
	};
}

function makeCtx(agentId: string, events: SessionEvent[]): ToolContext {
	return {
		cwd: "/tmp",
		signal: new AbortController().signal,
		approval: new ApprovalChain(),
		agentId,
		session: captureSession(events),
	};
}

function todoSet(agentId: string, todos: TodoItem[]): SessionEvent {
	return {
		type: "todo/set",
		id: randomUUID(),
		ts: new Date().toISOString(),
		agentId,
		todos,
	};
}

const LIST_A: TodoItem[] = [
	{ content: "read config", status: "completed" },
	{ content: "patch loader", status: "in_progress" },
	{ content: "add tests", status: "pending" },
];

const LIST_B: TodoItem[] = [{ content: "only one left", status: "pending" }];

describe("todoTool", () => {
	it("execute：append 一条 todo/set 快照（agentId/todos 齐全），返回渲染后的清单文本", async () => {
		const events: SessionEvent[] = [];
		const out = await todoTool.execute(
			{ todos: LIST_A },
			makeCtx("worker-1", events),
		);

		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.type).toBe("todo/set");
		if (event?.type !== "todo/set") throw new Error("unreachable");
		expect(event.agentId).toBe("worker-1");
		expect(event.todos).toEqual(LIST_A);
		expect(event.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(Number.isNaN(Date.parse(event.ts))).toBe(false);

		expect(out.isError ?? false).toBe(false);
		expect(out.content).toBe(
			"- [completed] read config\n- [in_progress] patch loader\n- [pending] add tests",
		);
	});

	it("全量替换语义：两次调用各落一条快照，fold 只认最后一条", async () => {
		const events: SessionEvent[] = [];
		await todoTool.execute({ todos: LIST_A }, makeCtx("worker-1", events));
		await todoTool.execute({ todos: LIST_B }, makeCtx("worker-1", events));

		// 两次调用各落一条 todo/set（append-only，历史不改写）
		expect(events.filter((e) => e.type === "todo/set")).toHaveLength(2);
		// 但最后生效的是第二条：全量替换，LIST_A 已被 LIST_B 覆盖
		expect(foldTodos(events, "worker-1")).toEqual(LIST_B);
	});

	it("空数组合法：清空清单（落一条空快照，fold 得到空列表）", async () => {
		const events: SessionEvent[] = [];
		await todoTool.execute({ todos: LIST_A }, makeCtx("worker-1", events));
		const out = await todoTool.execute(
			{ todos: [] },
			makeCtx("worker-1", events),
		);

		expect(out.content).toBe("");
		expect(foldTodos(events, "worker-1")).toEqual([]);
	});

	it("registry 层校验：status 非法或 content 为空时拒绝执行", async () => {
		const registry = createToolRegistry();
		registry.register(todoTool);
		const erased = registry.get("todo");
		const events: SessionEvent[] = [];
		const ctx = makeCtx("worker-1", events);

		await expect(
			erased?.execute({ todos: [{ content: "x", status: "doing" }] }, ctx),
		).rejects.toThrow();
		await expect(
			erased?.execute({ todos: [{ content: "", status: "pending" }] }, ctx),
		).rejects.toThrow();
		// 校验失败不落盘
		expect(events).toHaveLength(0);
	});
});

describe("foldTodos", () => {
	it("无 todo/set 记录返回空数组", () => {
		expect(foldTodos([], "worker-1")).toEqual([]);
		const others: SessionEvent[] = [
			{
				type: "user_msg",
				id: randomUUID(),
				ts: new Date().toISOString(),
				agentId: "worker-1",
				content: "do something",
			},
		];
		expect(foldTodos(others, "worker-1")).toEqual([]);
	});

	it("只认指定 agentId：其他 agent 的快照不混入", () => {
		const events: SessionEvent[] = [
			todoSet("worker-1", LIST_A),
			todoSet("worker-2", LIST_B),
		];
		expect(foldTodos(events, "worker-1")).toEqual(LIST_A);
		expect(foldTodos(events, "worker-2")).toEqual(LIST_B);
		// 未产生过 todo/set 的 agent 得到空清单
		expect(foldTodos(events, "task-1")).toEqual([]);
	});

	it("last-write-wins：同一 agent 多条快照只留最后一条", () => {
		const events: SessionEvent[] = [
			todoSet("worker-1", LIST_A),
			todoSet("worker-1", LIST_B),
			// 晚写入的其他 agent 事件不影响本 agent 的 fold
			todoSet("worker-2", LIST_A),
		];
		expect(foldTodos(events, "worker-1")).toEqual(LIST_B);
	});
});
