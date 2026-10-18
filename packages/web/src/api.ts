// REST client：与 server/src/app.ts 的路由契约一一对应。
// 错误统一抛出带服务端 message 的 Error，由调用方（App）兜底展示。

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
}

// GET /api/sessions/:id/prompts 的响应项（M4 prompt templates）
export interface PromptInfo {
	name: string;
	description: string;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(path, init);
	if (!res.ok) {
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
