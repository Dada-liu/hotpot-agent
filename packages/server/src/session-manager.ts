// 会话管理器（M3 服务层核心）：turn 串行化、审批桥接线、seq/订阅广播与 usage 统计。
// 回合装配镜像 packages/cli/src/chat.ts 的 runChat：
// - tier = settings.mainAgentTier ?? "high"；new ApprovalChain()，policy !== "never" 时
//   注册桥 handler（bridge.registerToolAsk）；整体经 createAuditedApprovalChain 落盘审计
// - policy === "always" 时 decorateWorkerTool 给非 read 工具包预审批（chat.ts withApproval
//   的等价重写，cli 包不可导入）
// - createRuntime + opts.llm 覆盖 resolveModel（scriptedAdapter 测试注入，同 chat.ts）
// - createInbox(session, "main", {onCancel, seed})；onPlanApproval 走桥的 registerPlanAsk
// - M4 Feature⑦ MCP：开关打开且 settings.mcpServers 非空时 connectMcpServers 建连，
//   工具经 mcpTools 注入 runtime；mcp/attached 经 watermark.session 落盘；
//   mcpCreateClient 为测试注入缝；manager.close 里 closeMcpConnections 统一关闭
//
// 事件转发架构规则（计划级决策）：
// - durable 事件只由 tailer 产出一条路径：迭代器收到的 tool_call/tool_result/
//   assistant_msg/user_msg 一律不转发（它们由 runTurn 落盘、tailer 推 log）
// - 迭代器只转发瞬态：text→delta、agent_spawn→spawn、plan→plan；done/error 不直发，
//   收敛为回合收尾的一次 turn(end)（complex 流的起草轮与执行轮各产 done，回合只有一个 end）
// - 边界同步：delta 前与 turn(end) 前 syncDurable()，保证 log(user_msg) 先于首个 delta、
//   log(assistant_msg) 先于 turn(end) 到达订阅者
//
// 广播顺序不变量：每会话一条 emit 管道（hub.emit 同步 fan-out 到订阅者），
// seq 在 emit 时刻分配；订阅时重放先于 live 到达（重放在注册回调前同步完成），
// live 事件按 seq 序推送——每订阅者的 FIFO 序由单线程同步交付天然保证。

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { LlmAdapter, ModelInfo } from "@hotpot/ai";
import {
	ApprovalChain,
	createAuditedApprovalChain,
	createSession,
	discoverSkills,
	featureEnabled,
	type InboxMessage,
	listSessions,
	loadSession,
	loadSettings,
	type ModelTier,
	resolveHome,
	resumeSession,
	type Session,
	type SessionEvent,
	type SessionSummary,
	type Settings,
	type ToolDefinition,
} from "@hotpot/core";
import {
	closeMcpConnections,
	connectMcpServers,
	createInbox,
	createRuntime,
	foldInbox,
	type Inbox,
	type InboxState,
	type McpClientFactory,
	type McpConnection,
	type OrchestrationRuntime,
	type PlanDecision,
	resolveModel,
	runMainTurn,
	type WorkerToolDecorator,
} from "@hotpot/orchestrator";
import { type ApprovalBridge, createApprovalBridge } from "./approvals.ts";
import { createTailer, type Tailer } from "./tailer.ts";
import { summarizeUsage, type UsageSummary } from "./usage.ts";
import {
	createWireHub,
	type WireEvent,
	type WireEventInput,
	type WireHub,
} from "./wire.ts";

// 主agent 的 agentId 固定 "main"：与 orchestrator 包级约定一致
const MAIN_AGENT_ID = "main";

type ApprovalPolicy = "ask-on-dangerous" | "always" | "never";

export interface SessionRecord {
	id: string;
	cwd: string;
	filePath: string;
	createdAt: string;
	// 是否有回合正在执行（turn 串行链非空闲）
	running: boolean;
}

export interface SessionManagerOptions {
	home?: string;
	// 测试注入点：缺省时按 settings 的 ModelRef 解析真实适配器（orchestrator 的 resolveModel）；
	// 存在时覆盖 runtime.resolveModel（main/worker 共用同一录制适配器），同 chat.ts opts.llm
	llm?: { adapter: LlmAdapter; model: ModelInfo };
	// 未知模型兜底等告警通道；缺省静默
	warn?: (text: string) => void;
	// 测试注入点：MCP 连接层打桩（缺省走真实 SDK client），配 mcpServers 配置做 attach 用例
	mcpCreateClient?: McpClientFactory;
}

export interface SessionManager {
	create(cwd: string): Promise<SessionRecord>;
	// 按会话 id 恢复（listSessions 找 filePath → resumeSession + foldInbox 播种），
	// 未命中返回 null
	attachById(id: string): Promise<SessionRecord | null>;
	get(id: string): SessionRecord | null;
	list(): Promise<(SessionSummary & { running: boolean })[]>;
	// turn 串行：挂到该会话的 turnTail 链尾，前一回合（含 followup 补发）结束后才执行
	send(id: string, content: string): Promise<void>;
	steer(id: string, content: string): Promise<void>;
	cancel(id: string): void;
	answerToolApproval(
		id: string,
		requestId: string,
		decision: "allow" | "deny",
	): boolean;
	answerPlan(id: string, decision: PlanDecision): boolean;
	// afterSeq 为 null 全量重放；否则增量补发（窗口外降级全量）。返回退订函数
	subscribe(
		id: string,
		afterSeq: number | null,
		sink: (e: WireEvent) => void,
	): () => void;
	// SSE 断线重连订阅：afterSeq 命中留存窗口则增量补发；为 null 走 buffer 全量；
	// 掉出窗口则 loadSession 全量日志重放——每条 durable 事件经 hub.replay 分配新 seq
	// （与 live 流 seq 连续）后先送达 sink。miss 路径先注册包装 sink 把 live 事件收进
	// pending，重放后按日志事件 id 去重泄洪、再同步换成真 sink：loadSession 期间的
	// live 事件不丢，先历史后 live 的到达序由同步段保证。返回退订函数
	subscribeResuming(
		id: string,
		afterSeq: number | null,
		sink: (e: WireEvent) => void,
	): Promise<() => void>;
	usage(id: string): Promise<UsageSummary>;
	close(id: string): Promise<void>;
}

interface ManagedSession {
	id: string;
	cwd: string;
	filePath: string;
	createdAt: string;
	tier: ModelTier;
	hub: WireHub;
	bridge: ApprovalBridge;
	inbox: Inbox;
	runtime: OrchestrationRuntime;
	tailer: Tailer;
	// M4 Feature⑦ MCP：本会话挂载的 MCP 连接（close 时统一关闭）
	mcpConnections: McpConnection[];
	emit: (input: WireEventInput) => WireEvent;
	syncDurable: () => Promise<void>;
	holder: { currentAbort: AbortController | null; running: boolean };
	// turn 串行链尾
	turnTail: Promise<void>;
	subscribers: Map<number, (e: WireEvent) => void>;
	nextSubscriberId: number;
}

// ---- append 水位包装：让「转发瞬态前」可以等待 tailer 把已落盘事件推齐 ----
// written = 包装后 append 完成的次数；delivered = tailer 已交付的次数。
// syncDurable() 等 delivered 追平 written——tailer 每批交付后重判等待者，无唤醒丢失。
// markBaseline() 在 tailer 初始补读完成后清零两计数：此后只比较增量，
// attach 场景里存量历史不影响同步判断。

interface AppendWatermark {
	session: Session;
	onDelivered(n: number): void;
	syncDurable(): Promise<void>;
	markBaseline(): void;
}

function wrapAppend(session: Session): AppendWatermark {
	let written = 0;
	let delivered = 0;
	const waiters: (() => void)[] = [];
	const base = session.append.bind(session);
	return {
		session: {
			...session,
			append: async (e: SessionEvent) => {
				await base(e);
				written += 1;
			},
		},
		onDelivered(n: number): void {
			delivered += n;
			if (delivered >= written) {
				while (waiters.length > 0) {
					waiters.shift()?.();
				}
			}
		},
		syncDurable(): Promise<void> {
			if (delivered >= written) return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiters.push(resolve);
			});
		},
		markBaseline(): void {
			written = 0;
			delivered = 0;
		},
	};
}

// ---- policy=always 的 worker 工具预审批包装（chat.ts withApproval 的等价重写） ----

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 工具入参摘要：input 来自 runTurn 的 JSON.parse，恒为 JSON-safe；防御性 try/catch 兜底
function summarizeInput(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input) ?? "";
	} catch {
		text = String(input);
	}
	return truncate(text, 120);
}

function withApproval<T>(
	tool: ToolDefinition<T>,
	kind: "command" | "write",
): ToolDefinition<T> {
	return {
		...tool,
		execute: async (args, ctx) => {
			const decision = await ctx.approval.ask({
				kind,
				summary: `Run tool "${tool.name}" (approval policy: always)`,
				detail: summarizeInput(args),
			});
			if (decision === "deny") {
				return {
					content: `tool "${tool.name}" denied by approval`,
					isError: true,
				};
			}
			return tool.execute(args, ctx);
		},
	};
}

export function createSessionManager(
	opts: SessionManagerOptions,
): SessionManager {
	const warn = opts.warn ?? (() => {});
	const managed = new Map<string, ManagedSession>();

	function requireManaged(id: string): ManagedSession {
		const m = managed.get(id);
		if (m === undefined) {
			throw new Error(`会话未管理: ${id}`);
		}
		return m;
	}

	// 装配：hub/桥/审批/runtime/inbox/tailer 闭包到同一会话上；tailer 初始补读后清基线
	async function assemble(init: {
		session: Session;
		cwd: string;
		settings: Settings;
		createdAt: string;
		inboxSeed?: InboxState;
	}): Promise<ManagedSession> {
		const { settings, cwd } = init;
		const tier = settings.mainAgentTier ?? "high";
		const ref = settings.models[tier];
		const hub = createWireHub();
		const holder: { currentAbort: AbortController | null; running: boolean } = {
			currentAbort: null,
			running: false,
		};
		const subscribers = new Map<number, (e: WireEvent) => void>();
		const watermark = wrapAppend(init.session);

		function emitLocal(input: WireEventInput): WireEvent {
			const full = hub.emit(input);
			for (const sink of subscribers.values()) {
				sink(full);
			}
			return full;
		}

		// 桥的广播接到本会话的 emit 管道：ask 入表后同步推送 approval 事件
		const bridge = createApprovalBridge((requestId, payload) => {
			if (payload.approvalType === "tool") {
				emitLocal({
					kind: "approval",
					requestId,
					approvalType: "tool",
					summary: payload.summary,
					detail: payload.detail,
				});
			} else {
				emitLocal({
					kind: "approval",
					requestId,
					approvalType: "plan",
					summary: payload.summary,
					plan: payload.plan,
				});
			}
		});

		// 审批装配镜像 chat.ts：server handler 挂内层链，整体经审计包装落盘 asked/decided。
		// never：不注册 handler，fail-closed 全部 deny（不打扰用户，也不放行）
		const policy: ApprovalPolicy =
			settings.approval?.policy ?? "ask-on-dangerous";
		const baseApproval = new ApprovalChain();
		if (policy !== "never") {
			baseApproval.use((req) => bridge.registerToolAsk(req));
		}
		const approval = createAuditedApprovalChain(baseApproval, {
			session: watermark.session,
			agentId: MAIN_AGENT_ID,
		});

		// policy=always：worker/task 的 bash/write/edit 包一层预审批；read 不包（无副作用）
		const decorateWorkerTool: WorkerToolDecorator | undefined =
			policy === "always"
				? (tool) =>
						tool.name === "read"
							? tool
							: withApproval(tool, tool.name === "bash" ? "command" : "write")
				: undefined;

		// M4 Feature⑦ MCP：开关（features.mcp，缺省开）打开且配置了 server 才连接。
		// 单 server 失败由 connectMcpServers 内部告警跳过，不阻塞装配；连接成功逐个经
		// watermark.session 落盘 mcp/attached（此时 tailer 未 start，初始补读会把它与
		// 历史事件一起交付，markBaseline 清计数，无水位悬挂）。mcpCreateClient 为测试注入缝
		const mcpConnections: McpConnection[] = [];
		if (
			featureEnabled(settings.features, "mcp") &&
			settings.mcpServers !== undefined &&
			Object.keys(settings.mcpServers).length > 0
		) {
			mcpConnections.push(
				...(await connectMcpServers(settings.mcpServers, {
					cwd,
					warn,
					...(opts.mcpCreateClient === undefined
						? {}
						: { createClient: opts.mcpCreateClient }),
				})),
			);
			for (const conn of mcpConnections) {
				await watermark.session.append({
					type: "mcp/attached",
					id: randomUUID(),
					ts: new Date().toISOString(),
					server: conn.name,
					transport: conn.transport,
					tools: conn.tools.map((t) => t.name),
				});
			}
		}

		// M4 Feature④ skill：开关（features.skills，缺省开）打开时扫描
		// skillsDirs（相对 cwd 解析）→ <home>/skills → <cwd>/.hotpot/skills
		// （只查 cwd 一级、不向上逐级，已知边界见 orchestrator README）；
		// discoverSkills 同名去重、后扫描者胜：项目级 > home > skillsDirs
		const skills = featureEnabled(settings.features, "skills")
			? await discoverSkills([
					...(settings.skillsDirs ?? []).map((d) => resolve(cwd, d)),
					join(resolveHome(opts.home), "skills"),
					join(cwd, ".hotpot", "skills"),
				])
			: [];

		const baseRuntime = createRuntime({
			session: watermark.session,
			cwd,
			approval,
			models: settings.models,
			maxParallelTasks: settings.maxParallelTasks,
			planMaxRevisions: settings.planMaxRevisions,
			decorateWorkerTool,
			features: settings.features,
			skills,
			mcpTools: mcpConnections.flatMap((c) => c.tools),
			webSearch: settings.webSearch,
		});
		// opts.llm 覆盖档位解析（main/worker 共用同一录制适配器）；
		// 未注入时仅为主档位解析一次拿兜底告警（runtime 内部每回合自行解析）
		const llm = opts.llm;
		if (!llm) {
			const resolved = resolveModel(ref);
			if (resolved.warning !== undefined) {
				warn(resolved.warning);
			}
		}
		const runtime: OrchestrationRuntime = {
			...baseRuntime,
			...(llm
				? {
						resolveModel: (_t: ModelTier) => ({
							adapter: llm.adapter,
							model: llm.model,
							apiKey: ref.apiKey,
							baseUrl: ref.baseUrl,
						}),
					}
				: {}),
		};

		const inbox = createInbox(watermark.session, MAIN_AGENT_ID, {
			onCancel: () => holder.currentAbort?.abort(),
			...(init.inboxSeed === undefined ? {} : { seed: init.inboxSeed }),
		});

		// durable 唯一路径：tailer 每条事件推一条 log；整批交付后推进水位
		const tailer = createTailer(init.session.filePath, {
			fromOffset: 0,
			onEvents: (events) => {
				for (const e of events) {
					emitLocal({ kind: "log", event: e });
				}
				watermark.onDelivered(events.length);
			},
		});

		const m: ManagedSession = {
			id: init.session.id,
			cwd,
			filePath: init.session.filePath,
			createdAt: init.createdAt,
			tier,
			hub,
			bridge,
			inbox,
			runtime,
			tailer,
			mcpConnections,
			emit: emitLocal,
			syncDurable: watermark.syncDurable,
			holder,
			turnTail: Promise.resolve(),
			subscribers,
			nextSubscriberId: 1,
		};
		await tailer.start();
		watermark.markBaseline();
		return m;
	}

	// 单回合：emit turn(start) → 迭代转发瞬态 → 收尾 emit turn(end)。
	// 异常不抛出（吞进 turn(end, {error})）；done 的 stopReason 与 error 事件收敛到回合级 turn(end)
	async function runOneTurn(m: ManagedSession, content: string): Promise<void> {
		m.emit({ kind: "turn", phase: "start" });
		const ac = new AbortController();
		m.holder.currentAbort = ac;
		m.holder.running = true;
		let stopReason: string | undefined;
		let error: string | undefined;
		try {
			for await (const event of runMainTurn({
				runtime: m.runtime,
				userMessage: content,
				signal: ac.signal,
				mainTier: m.tier,
				onPlanApproval: (plan) => m.bridge.registerPlanAsk(plan),
				inbox: m.inbox,
			})) {
				if (event.type === "text") {
					// 边界同步：首个 delta 前把 log(user_msg) 等已落盘事件推齐
					await m.syncDurable();
					m.emit({
						kind: "delta",
						agentId: MAIN_AGENT_ID,
						text: event.delta,
					});
				} else if (event.type === "agent_spawn") {
					// 瞬态 spawn 先行（不做边界同步，保住「worker 诞生早通知」语义）；
					// parentAgentId 固定 main：主流内全部 spawn 都以 main 为父。
					// role 防御性收窄：wire 协议只有 worker/task，编排层也不会产 main 角色
					if (event.role === "worker" || event.role === "task") {
						m.emit({
							kind: "spawn",
							agentId: event.agentId,
							role: event.role,
							tier: event.tier,
							task: event.task,
							parentAgentId: MAIN_AGENT_ID,
						});
					}
				} else if (event.type === "plan") {
					m.emit({ kind: "plan", phase: event.phase, plan: event.plan });
				} else if (event.type === "done") {
					stopReason = event.stopReason;
				} else if (event.type === "error") {
					error = `${event.error.code}: ${event.error.message}`;
				}
				// tool_call/tool_result/assistant_msg/user_msg 不转发：
				// 它们由 runTurn 落盘、tailer 经 log 路径推送
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			m.holder.currentAbort = null;
			m.holder.running = false;
		}
		// 收尾边界同步：log(assistant_msg) 等全部 durable 推齐后再发 turn(end)
		await m.syncDurable();
		m.emit({ kind: "turn", phase: "end", stopReason, error });
	}

	// 一回合 + followup 补发循环（同 CLI：turn 结束后 drain next-turn 逐个补发为新回合）
	async function runTurnWithFollowups(
		m: ManagedSession,
		content: string,
	): Promise<void> {
		await runOneTurn(m, content);
		let followups: InboxMessage[] = await m.inbox.drainNextTurn();
		while (followups.length > 0) {
			for (const followup of followups) {
				await runOneTurn(m, followup.content);
			}
			followups = await m.inbox.drainNextTurn();
		}
	}

	function recordOf(m: ManagedSession): SessionRecord {
		return {
			id: m.id,
			cwd: m.cwd,
			filePath: m.filePath,
			createdAt: m.createdAt,
			running: m.holder.running,
		};
	}

	// live 回调注册（subscribe/subscribeResuming 共用）：补发在调用方同步完成后执行，
	// 保证重放事件先于 live 到达同一订阅者
	function registerLive(
		m: ManagedSession,
		sink: (e: WireEvent) => void,
	): () => void {
		const subId = m.nextSubscriberId;
		m.nextSubscriberId += 1;
		m.subscribers.set(subId, sink);
		return () => {
			m.subscribers.delete(subId);
		};
	}

	return {
		async create(cwd: string): Promise<SessionRecord> {
			const settings = loadSettings({ cwd, home: opts.home });
			const session = await createSession(cwd, opts.home);
			const { meta } = await loadSession(session.filePath);
			if (meta.type !== "meta") {
				throw new Error(`会话文件缺 meta 头: ${session.filePath}`);
			}
			const m = await assemble({
				session,
				cwd,
				settings,
				createdAt: meta.createdAt,
			});
			managed.set(m.id, m);
			return recordOf(m);
		},

		async attachById(id: string): Promise<SessionRecord | null> {
			const summaries = await listSessions(opts.home);
			const summary = summaries.find((s) => s.id === id);
			if (summary === undefined) return null;
			const { meta, events } = await loadSession(summary.filePath);
			if (meta.type !== "meta") return null;
			const session = await resumeSession(summary.filePath);
			const settings = loadSettings({ cwd: meta.cwd, home: opts.home });
			const m = await assemble({
				session,
				cwd: meta.cwd,
				settings,
				createdAt: meta.createdAt,
				inboxSeed: foldInbox(events),
			});
			managed.set(m.id, m);
			return recordOf(m);
		},

		get(id: string): SessionRecord | null {
			const m = managed.get(id);
			return m === undefined ? null : recordOf(m);
		},

		async list(): Promise<(SessionSummary & { running: boolean })[]> {
			const summaries = await listSessions(opts.home);
			return summaries.map((s) => {
				const m = managed.get(s.id);
				return { ...s, running: m ? m.holder.running : false };
			});
		},

		send(id: string, content: string): Promise<void> {
			const m = requireManaged(id);
			const run = () => runTurnWithFollowups(m, content);
			// turn 串行链：挂到链尾；链断（前序异常）也不跳过本回合（runOneTurn 自身不抛）
			m.turnTail = m.turnTail.then(run, run);
			return Promise.resolve();
		},

		async steer(id: string, content: string): Promise<void> {
			const m = requireManaged(id);
			await m.inbox.steer(content);
		},

		cancel(id: string): void {
			const m = requireManaged(id);
			m.inbox.cancel();
		},

		answerToolApproval(
			id: string,
			requestId: string,
			decision: "allow" | "deny",
		): boolean {
			const m = managed.get(id);
			if (m === undefined) return false;
			return m.bridge.answer(requestId, decision);
		},

		answerPlan(id: string, decision: PlanDecision): boolean {
			const m = managed.get(id);
			if (m === undefined) return false;
			return m.bridge.answerPendingPlan(decision);
		},

		subscribe(
			id: string,
			afterSeq: number | null,
			sink: (e: WireEvent) => void,
		): () => void {
			const m = requireManaged(id);
			// 补发：afterSeq 为 null 全量重放；增量窗口外（tailAfter 返回 null）降级全量
			const catchUp =
				afterSeq === null
					? m.hub.buffer()
					: (m.hub.tailAfter(afterSeq) ?? m.hub.buffer());
			for (const e of catchUp) {
				sink(e);
			}
			return registerLive(m, sink);
		},

		async subscribeResuming(
			id: string,
			afterSeq: number | null,
			sink: (e: WireEvent) => void,
		): Promise<() => void> {
			const m = requireManaged(id);
			if (afterSeq === null) {
				for (const e of m.hub.buffer()) {
					sink(e);
				}
				return registerLive(m, sink);
			}
			// 命中留存窗口：增量补发（同步段，注册前无 await）
			if (m.hub.hasSeq(afterSeq)) {
				const incremental = m.hub.tailAfter(afterSeq);
				if (incremental !== null) {
					for (const e of incremental) {
						sink(e);
					}
					return registerLive(m, sink);
				}
			}
			// 掉出窗口：全量日志重放。为堵住 loadSession 期间的 live 窗口，先注册包装
			// sink 把 live 事件收进 pending（同步注册，先于任何 await），重放完成后
			// 再把 pending 泄洪并同步换成真 sink——泄洪与换 sink 在同一同步段完成，
			// 任何 emit 要么已进 pending、要么直送 sink，事件不会落在缝隙里
			const pending: WireEvent[] = [];
			const subId = m.nextSubscriberId;
			m.nextSubscriberId += 1;
			m.subscribers.set(subId, (e) => {
				pending.push(e);
			});
			let logEvents: SessionEvent[];
			try {
				const loaded = await loadSession(m.filePath);
				logEvents = loaded.events;
			} catch (err) {
				m.subscribers.delete(subId);
				throw err;
			}
			// 重放：durable 事件经 hub.replay 借 emit 管道分配新 seq（seq 与 live 流
			// 连续、单调；hub.replay 不入公共 buffer、不广播，其他订阅者不受影响）
			const replayedIds = new Set<string>();
			let sawMeta = false;
			for (const e of logEvents) {
				if (e.type === "meta") sawMeta = true;
				else replayedIds.add(e.id);
				sink(m.hub.replay({ kind: "log", event: e }));
			}
			// 泄洪 pending：重放已覆盖的 durable 事件按日志事件 id 去重（tailer 与本
			// 连接重放读到同一批历史时只留一份）；瞬态事件不在日志中，一律补发
			for (const e of pending) {
				if (e.kind === "log") {
					if (e.event.type === "meta") {
						if (sawMeta) continue;
					} else if (replayedIds.has(e.event.id)) {
						continue;
					}
				}
				sink(e);
			}
			m.subscribers.set(subId, sink);
			return () => {
				m.subscribers.delete(subId);
			};
		},

		async usage(id: string): Promise<UsageSummary> {
			const m = requireManaged(id);
			const { events } = await loadSession(m.filePath);
			return summarizeUsage(events);
		},

		async close(id: string): Promise<void> {
			const m = requireManaged(id);
			// 会话销毁：未决审批一律拒绝（tool 型 deny；plan 型 reject），
			// 让 parked promise 落盘 decided 并释放等待中的回合链
			for (const requestId of m.bridge.pending()) {
				if (!m.bridge.answer(requestId, "deny")) {
					m.bridge.answer(requestId, {
						kind: "reject",
						note: "session closed",
					});
				}
			}
			m.tailer.stop();
			// managed 同步摘除保持旧行为（close 不 await 时 get 立即为 null）；
			// MCP 连接关闭是异步收尾，放最后不阻塞摘除
			managed.delete(id);
			await closeMcpConnections(m.mcpConnections);
		},
	};
}
