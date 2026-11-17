import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkspaceWire } from "../src/api.ts";
import {
	groupSessionsByWorkspace,
	workspaceForSession,
} from "../src/lib/workspaces.ts";

function session(
	id: string,
	updatedAt: string,
	createdAt = updatedAt,
): SessionSummary {
	return { id, cwd: `/tmp/${id}`, createdAt, updatedAt, turn: "idle" };
}

function workspace(id: string, sessionIds: string[]): WorkspaceWire {
	return {
		id,
		path: `/tmp/${id}`,
		title: id,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		sessionIds,
	};
}

describe("groupSessionsByWorkspace", () => {
	it("组顺序取注册表顺序，组内按最后修改时间倒序", () => {
		const result = groupSessionsByWorkspace(
			[workspace("w2", ["s3", "s1"]), workspace("w1", ["s2"])],
			[
				session("s1", "2026-01-05T00:00:00.000Z"),
				session("s2", "2026-01-02T00:00:00.000Z"),
				session("s3", "2026-01-03T00:00:00.000Z"),
			],
		);
		expect(result.groups.map((g) => g.workspace.id)).toEqual(["w2", "w1"]);
		// w2 的注册表顺序是 [s3, s1]，但 s1 修改更晚，应排在前面
		expect(result.groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s3"]);
		expect(result.groups[1].sessions.map((s) => s.id)).toEqual(["s2"]);
		expect(result.ungrouped).toEqual([]);
	});

	it("组内排序用 updatedAt 而不是 createdAt", () => {
		const result = groupSessionsByWorkspace(
			[workspace("w1", ["created-late", "edited-late"])],
			[
				// 创建晚但一直没活动
				session(
					"created-late",
					"2026-01-01T00:00:00.000Z",
					"2026-03-01T00:00:00.000Z",
				),
				// 创建早但刚有活动
				session(
					"edited-late",
					"2026-03-02T00:00:00.000Z",
					"2026-01-01T00:00:00.000Z",
				),
			],
		);
		expect(result.groups[0].sessions.map((s) => s.id)).toEqual([
			"edited-late",
			"created-late",
		]);
	});

	it("过滤注册表中已不存在的会话 id", () => {
		const result = groupSessionsByWorkspace(
			[workspace("w1", ["gone", "s1"])],
			[session("s1", "2026-01-01T00:00:00.000Z")],
		);
		expect(result.groups[0].sessions.map((s) => s.id)).toEqual(["s1"]);
		expect(result.ungrouped).toEqual([]);
	});

	it("未归属会话进未分组并按 updatedAt 降序", () => {
		const result = groupSessionsByWorkspace(
			[workspace("w1", ["s1"])],
			[
				session("s1", "2026-01-01T00:00:00.000Z"),
				session("old", "2025-12-01T00:00:00.000Z"),
				session("new", "2026-02-01T00:00:00.000Z"),
				session("mid", "2026-01-15T00:00:00.000Z"),
			],
		);
		expect(result.ungrouped.map((s) => s.id)).toEqual(["new", "mid", "old"]);
	});

	it("重复归属按首次出现去重（防御脏注册表）", () => {
		const result = groupSessionsByWorkspace(
			[workspace("w1", ["s1", "s1"]), workspace("w2", ["s1"])],
			[session("s1", "2026-01-01T00:00:00.000Z")],
		);
		expect(result.groups[0].sessions.map((s) => s.id)).toEqual(["s1"]);
		expect(result.groups[1].sessions).toEqual([]);
		expect(result.ungrouped).toEqual([]);
	});

	it("空输入返回空分组与空未分组", () => {
		expect(groupSessionsByWorkspace([], [])).toEqual({
			groups: [],
			ungrouped: [],
		});
	});

	it("有工作区但无会话时组仍在（空态由组件渲染）", () => {
		const result = groupSessionsByWorkspace([workspace("w1", [])], []);
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0].sessions).toEqual([]);
		expect(result.ungrouped).toEqual([]);
	});
});

describe("workspaceForSession", () => {
	it("返回包含该会话的工作区", () => {
		const workspaces = [workspace("w1", ["s1"]), workspace("w2", ["s2"])];
		expect(workspaceForSession(workspaces, "s2")?.id).toBe("w2");
	});

	it("未归属返回 null", () => {
		expect(workspaceForSession([workspace("w1", ["s1"])], "s9")).toBeNull();
		expect(workspaceForSession([], "s1")).toBeNull();
	});
});
