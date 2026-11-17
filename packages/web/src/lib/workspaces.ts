// 工作区分组：按注册表顺序切组；组内与「未分组」都按会话最后修改时间（updatedAt）
// 倒序 —— 最近有活动的会话排最上面。sessionIds 只表达归属关系，不再决定展示顺序。
// 纯函数，node 下可单测。

import type { SessionSummary, WorkspaceWire } from "../api.ts";

export interface WorkspaceGroup {
	workspace: WorkspaceWire;
	sessions: SessionSummary[];
}

export interface GroupedSessions {
	groups: WorkspaceGroup[];
	ungrouped: SessionSummary[];
}

function modifiedTime(session: SessionSummary): number {
	// 旧服务端可能没有 updatedAt：退回 createdAt，保证排序仍有确定结果
	const t = Date.parse(session.updatedAt ?? session.createdAt);
	return Number.isNaN(t) ? 0 : t;
}

// 最近修改优先；同一时间戳保持传入顺序（Array#sort 稳定），即注册表里的相对顺序
function byRecentActivity(a: SessionSummary, b: SessionSummary): number {
	return modifiedTime(b) - modifiedTime(a);
}

// 防御性去重：服务端保证一个会话只属一个工作区，但客户端仍以首次出现为准，
// 避免注册表脏数据让同一会话在侧栏出现两次
export function groupSessionsByWorkspace(
	workspaces: WorkspaceWire[],
	sessions: SessionSummary[],
): GroupedSessions {
	const byId = new Map(sessions.map((s) => [s.id, s]));
	const claimed = new Set<string>();
	const groups = workspaces.map((workspace) => {
		const members: SessionSummary[] = [];
		for (const id of workspace.sessionIds) {
			if (claimed.has(id)) {
				continue;
			}
			const session = byId.get(id);
			if (session === undefined) {
				// 注册表保留未知 id（磁盘会话可能已删除）：客户端按实际会话过滤
				continue;
			}
			claimed.add(id);
			members.push(session);
		}
		return { workspace, sessions: members.sort(byRecentActivity) };
	});
	const ungrouped = sessions
		.filter((s) => !claimed.has(s.id))
		.sort(byRecentActivity);
	return { groups, ungrouped };
}

export function workspaceForSession(
	workspaces: WorkspaceWire[],
	sessionId: string,
): WorkspaceWire | null {
	return workspaces.find((w) => w.sessionIds.includes(sessionId)) ?? null;
}
