// REST client：与 server/src/app.ts 的路由契约一一对应。
// 错误统一抛出带服务端 message 的 Error，由调用方（App）兜底展示。

import type { InboxSnapshot } from "./protocol.ts";

export type { InboxSnapshot } from "./protocol.ts";

export interface SessionSummary {
	id: string;
	cwd: string;
	createdAt: string;
	turn: "running" | "idle";
}

// GET /api/sessions/:id/usage 的响应镜像（server usage.ts UsageSummary 的子集）
export interface UsageSummary {
	total: { input: number; output: number };
	byTier: Record<string, { input: number; output: number; count: number }>;
	byAgent: Record<string, { input: number; output: number }>;
	// M4 功能用量（开关 + 事件/工具调用计数）
	features: Record<
		string,
		{ enabled: boolean; events: number; toolCalls: number }
	>;
}

// GET /api/sessions/:id/prompts 的响应项（M4 prompt templates）
export interface PromptInfo {
	name: string;
	description: string;
}

// 非 2xx 统一抛出带服务端 message 的 Error；2xx 直接返回（不读响应体）
async function ensureOk(res: Response): Promise<void> {
	if (res.ok) {
		return;
	}
	let message = `HTTP ${res.status}`;
	try {
		const body = (await res.json()) as { error?: unknown };
		if (typeof body.error === "string") {
			message = body.error;
		}
	} catch {
		// 非 JSON 错误体：保留状态码作为 message
	}
	throw new Error(message);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(path, init);
	await ensureOk(res);
	return res.json();
}

function post(path: string, body?: unknown): Promise<unknown> {
	return request(path, {
		method: "POST",
		headers:
			body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export async function listSessions(): Promise<SessionSummary[]> {
	const body = (await request("/api/sessions")) as {
		sessions: SessionSummary[];
	};
	return body.sessions;
}

export async function createSession(cwd?: string): Promise<string> {
	const body = (await post(
		"/api/sessions",
		cwd === undefined ? {} : { cwd },
	)) as {
		id: string;
	};
	return body.id;
}

// DELETE 无响应体（204）：只走状态检查，失败抛出带服务端 message 的 Error
export async function deleteSession(sessionId: string): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
	});
	await ensureOk(res);
}

// 归档：结束运行中的回合并全部落盘，服务端摘托管但保留磁盘日志
export async function archiveSession(sessionId: string): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/archive`);
}

export async function sendMessage(
	sessionId: string,
	content: string,
): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
		content,
	});
}

export async function steerMessage(
	sessionId: string,
	content: string,
): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/steer`, {
		content,
	});
}

export async function cancelTurn(sessionId: string): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`);
}

export async function answerApproval(
	sessionId: string,
	requestId: string,
	decision: "allow" | "deny",
): Promise<void> {
	await post(
		`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}`,
		{ decision },
	);
}

export async function answerPlan(
	sessionId: string,
	decision: "approve" | "reject" | "annotate",
	note?: string,
): Promise<void> {
	await post(`/api/sessions/${encodeURIComponent(sessionId)}/plan`, {
		decision,
		...(note === undefined ? {} : { note }),
	});
}

export async function getUsage(sessionId: string): Promise<UsageSummary> {
	return (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/usage`,
	)) as UsageSummary;
}

export async function listPrompts(sessionId: string): Promise<PromptInfo[]> {
	const body = (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/prompts`,
	)) as { prompts: PromptInfo[] };
	return body.prompts;
}

export async function getInbox(sessionId: string): Promise<InboxSnapshot> {
	return (await request(
		`/api/sessions/${encodeURIComponent(sessionId)}/inbox`,
	)) as InboxSnapshot;
}

// GET/PUT /api/settings 的模型设置视图（server settings-store.ts 的 ModelSettingsView 镜像）
export interface ModelRefWire {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
}

export type ModelTier = "high" | "medium" | "low";

export interface ModelSettings {
	models: Record<ModelTier, ModelRefWire>;
	mainAgentTier?: ModelTier;
}

export async function getModelSettings(): Promise<ModelSettings> {
	return (await request("/api/settings")) as ModelSettings;
}

export async function updateModelSettings(
	settings: ModelSettings,
): Promise<ModelSettings> {
	return (await request("/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	})) as ModelSettings;
}
