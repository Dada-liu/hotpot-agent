// HTTP 外壳（M3）：Hono REST + SSE。
// - 全部路由挂 /api/sessions*，错误统一 {error: string} 形态 + 合适状态码
// - SSE（GET /:id/events）：帧格式 `id: <seq>` + `data: <WireEvent JSON>`，每 15s 一条
//   `: ping` 注释保活；断线（ReadableStream cancel）即退订
// - 重连补发：?after= 优先于 Last-Event-ID 头，交给 manager.subscribeResuming——
//   命中 ring buffer 窗口走增量；掉出窗口走全量日志重放（seq 经 hub.replay 重新分配，
//   与 live 流连续）
// - 订阅在 Response 返回（首字节发出）之前完成注册：客户端收到 200 即补发完毕、
//   live 通道就绪，彻底排除「连接已通、订阅未注册」的竞态
// - sink 自包 try/catch：manager 的 emit 是同步广播，sink 抛错会杀死广播循环

import { type Context, Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "./session-manager.ts";
import { PromptCommandError } from "./session-manager.ts";
import type { WireEvent } from "./wire.ts";

const createSessionSchema = z.object({
	cwd: z.string().optional(),
});
const messageSchema = z.object({
	content: z.string(),
});
const approvalSchema = z.object({
	decision: z.enum(["allow", "deny"]),
});
const planSchema = z.object({
	decision: z.enum(["approve", "reject", "annotate"]),
	note: z.string().optional(),
});

// 读取 JSON body：空 body 视为 {}；非法 JSON 返回 undefined（调用方转 400）
async function readJsonBody(c: Context): Promise<unknown> {
	const text = await c.req.text();
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// 解析 SSE 的 after：query 参数 ?after= 优先，其次 Last-Event-ID 头；
// 非法值返回 NaN（调用方转 400），缺省为 null
function resolveAfterSeq(c: Context): number | null {
	const query = c.req.query("after");
	const header = c.req.header("Last-Event-ID");
	const raw = query ?? header;
	if (raw === undefined) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) return Number.NaN;
	return n;
}

const SSE_HEADERS = {
	"Content-Type": "text/event-stream; charset=utf-8",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
};
const PING_INTERVAL_MS = 15000;

async function handleEvents(
	manager: SessionManager,
	id: string,
	afterSeq: number | null,
): Promise<Response> {
	const encoder = new TextEncoder();
	const holder: {
		controller: ReadableStreamDefaultController<Uint8Array> | null;
	} = { controller: null };
	let unsubscribe: (() => void) | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		if (pingTimer !== null) clearInterval(pingTimer);
		unsubscribe?.();
	};
	// sink 自包 try/catch：enqueue 失败（流已关闭）只清理本连接，不上抛进广播循环
	const write = (e: WireEvent): void => {
		const controller = holder.controller;
		if (controller === null) return;
		try {
			controller.enqueue(
				encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`),
			);
		} catch {
			cleanup();
		}
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			holder.controller = controller;
		},
		cancel() {
			cleanup();
		},
	});
	// 订阅（含补发重放）先完成，再返回 Response：首字节到达时 live 通道必已就绪
	unsubscribe = await manager.subscribeResuming(id, afterSeq, write);
	pingTimer = setInterval(() => {
		const controller = holder.controller;
		if (controller === null) return;
		try {
			controller.enqueue(encoder.encode(": ping\n\n"));
		} catch {
			cleanup();
		}
	}, PING_INTERVAL_MS);
	return new Response(stream, { headers: SSE_HEADERS });
}

export function createApp(manager: SessionManager): Hono {
	const app = new Hono();

	app.onError((err, c) => {
		return c.json(
			{ error: err instanceof Error ? err.message : String(err) },
			500,
		);
	});

	// 受管会话存在性：内存 managed 表未命中时降级 attachById 恢复磁盘上的会话
	// （CLI/其他进程创建的会话经 listSessions 可见，也必须能打开与订阅）；
	// attach 同样未命中才 404。attachById 是异步的，调用方必须 await
	const requireSession = async (id: string) => {
		const rec = manager.get(id);
		if (rec !== null) return rec;
		return manager.attachById(id);
	};

	app.get("/api/sessions", async (c) => {
		const sessions = await manager.list();
		return c.json({
			sessions: sessions.map((s) => ({
				id: s.id,
				cwd: s.cwd,
				createdAt: s.createdAt,
				turn: s.running ? "running" : "idle",
			})),
		});
	});

	app.post("/api/sessions", async (c) => {
		const body = await readJsonBody(c);
		const parsed = createSessionSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {cwd?: string}" }, 400);
		}
		const rec = await manager.create(parsed.data.cwd ?? process.cwd());
		return c.json({ id: rec.id }, 201);
	});

	app.get("/api/sessions/:id", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const usage = await manager.usage(rec.id);
		return c.json({
			id: rec.id,
			cwd: rec.cwd,
			createdAt: rec.createdAt,
			filePath: rec.filePath,
			turn: rec.running ? "running" : "idle",
			usage,
		});
	});

	app.get("/api/sessions/:id/events", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const afterSeq = resolveAfterSeq(c);
		if (Number.isNaN(afterSeq)) {
			return c.json({ error: "after 需为非负整数" }, 400);
		}
		return handleEvents(manager, rec.id, afterSeq);
	});

	app.post("/api/sessions/:id/messages", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {content: string}" }, 400);
		}
		try {
			await manager.send(rec.id, parsed.data.content);
		} catch (err) {
			// 未知斜杠命令：400 并带可用命令（消息不进入回合）
			if (err instanceof PromptCommandError) {
				return c.json({ error: err.message }, 400);
			}
			throw err;
		}
		return c.json({}, 202);
	});

	// M4 Feature⑤：当前会话可用的 prompt templates（web 端 `/` 补全用）
	app.get("/api/sessions/:id/prompts", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		return c.json({ prompts: manager.prompts(rec.id) });
	});

	app.post("/api/sessions/:id/steer", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "body 需为 {content: string}" }, 400);
		}
		await manager.steer(rec.id, parsed.data.content);
		return c.json({}, 202);
	});

	app.post("/api/sessions/:id/cancel", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		manager.cancel(rec.id);
		return c.json({}, 202);
	});

	app.post("/api/sessions/:id/approvals/:requestId", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = approvalSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: 'body 需为 {decision: "allow"|"deny"}' }, 400);
		}
		const ok = manager.answerToolApproval(
			rec.id,
			c.req.param("requestId"),
			parsed.data.decision,
		);
		if (!ok) return c.json({ error: "未知 requestId" }, 404);
		return c.json({});
	});

	app.post("/api/sessions/:id/plan", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		const body = await readJsonBody(c);
		const parsed = planSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{ error: 'body 需为 {decision: "approve"|"reject"|"annotate", note?}' },
				400,
			);
		}
		if (parsed.data.decision !== "approve" && parsed.data.note === undefined) {
			return c.json({ error: "reject/annotate 需附 note" }, 400);
		}
		const decision =
			parsed.data.decision === "approve"
				? { kind: "approve" as const }
				: parsed.data.decision === "reject"
					? { kind: "reject" as const, note: parsed.data.note ?? "" }
					: { kind: "annotate" as const, note: parsed.data.note ?? "" };
		const ok = manager.answerPlan(rec.id, decision);
		if (!ok) return c.json({ error: "无待审批的 plan" }, 404);
		return c.json({});
	});

	app.get("/api/sessions/:id/usage", async (c) => {
		const rec = await requireSession(c.req.param("id"));
		if (rec === null) return c.json({ error: "会话不存在" }, 404);
		return c.json(await manager.usage(rec.id));
	});

	return app;
}
