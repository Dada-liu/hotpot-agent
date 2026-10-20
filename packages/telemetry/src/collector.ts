// Turn 采集器：一个用户 turn 一个实例。
// 前半段观察编排事件流（done/error/plan/agent_spawn）判定结果，后半段从会话 JSONL
// 折叠整棵 agent 树的匿名指标。只读取会话日志的元数据字段（类型、时间、usage、model、
// tier、agentId），绝不输出 content、input、工具输出或任何原始文本；错误信息统一经
// sanitizeErrorMessage 脱敏。会话事件契约保持 v1 不变，采集器只消费不修改。

import { randomUUID } from "node:crypto";
import {
	featureEnabled,
	loadSession,
	type Session,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import type {
	AgentRole,
	ErrorEvent,
	FeatureUsageEvent,
	LlmCallEvent,
	SessionEndEvent,
	SessionStartEvent,
	TelemetryEvent,
	TokenTotals,
	ToolCallEvent,
	TurnEndEvent,
	TurnOutcome,
	TurnStartEvent,
} from "./events.ts";
import { sanitizeErrorMessage } from "./sanitize.ts";

// 观察边界用最小结构类型：cli/server 直接传自己的 OrchestrationEvent 联合即可，
// 本包因此不需要依赖 @hotpot/orchestrator（避免遥测层与编排层耦合）。
// 只声明判定 outcome 需要的字段，其余事件类型一律忽略。
export interface ObservedOrchestrationEvent {
	type: string;
	stopReason?: string;
	error?: { code: string; message: string };
	phase?: string;
	role?: string;
}

export interface TelemetryCollectorOptions {
	session: Session;
	sessionId: string;
	turnId: string;
	// appVersion 只用于 session 级事件，turn 事件契约里没有该字段；
	// 保留在工厂签名里是为了让 cli/server 用同一套参数组装所有采集器
	appVersion: string;
	features?: Settings["features"];
	now?: () => number;
}

export interface TelemetryCollector {
	start(): TurnStartEvent;
	observe(event: ObservedOrchestrationEvent): void;
	finish(opts?: {
		aborted?: boolean;
		planRejected?: boolean;
	}): Promise<TelemetryEvent[]>;
}

// 功能使用量按固定顺序输出，保证同一 turn 的事件顺序稳定，便于测试与聚合
const FEATURE_KEYS: FeatureKey[] = [
	"todo",
	"hooks",
	"skills",
	"promptTemplates",
	"webSearch",
	"webFetch",
	"mcp",
];

type FeatureKey = keyof NonNullable<Settings["features"]>;

interface FeatureCounts {
	events: number;
	toolCalls: number;
}

interface FoldContext {
	turnId: string;
	features: Settings["features"] | undefined;
	emittedAt: string;
}

interface FoldResult {
	events: TelemetryEvent[];
	inputTokens: number;
	outputTokens: number;
	mainSteps: number;
	assistantMessages: number;
	workerCount: number;
	taskCount: number;
	errorCount: number;
	byTier: Record<string, TokenTotals>;
	byModel: Record<string, TokenTotals>;
}

export function createTelemetryCollector(
	opts: TelemetryCollectorOptions,
): TelemetryCollector {
	const now = opts.now ?? Date.now;
	// startTs 在创建时锁定：turn 开始前就存在的历史事件不能折进本 turn
	const startedAt = now();
	const startTs = new Date(startedAt).toISOString();

	// 观察到的编排状态，finish 时与日志折叠结果合并判定 outcome
	let stopReason: string | undefined;
	let observedError: { code: string; message: string } | undefined;
	const planPhases = new Set<string>();
	const observedSpawnCounts: Record<"worker" | "task", number> = {
		worker: 0,
		task: 0,
	};

	function start(): TurnStartEvent {
		return {
			eventId: randomUUID(),
			ts: new Date(now()).toISOString(),
			type: "turn_start",
			turnId: opts.turnId,
			sessionId: opts.sessionId,
		};
	}

	function observe(event: ObservedOrchestrationEvent): void {
		switch (event.type) {
			case "done":
				stopReason = event.stopReason;
				break;
			case "error":
				// 拷出 code/message，避免持有调用方的可变错误对象
				if (event.error !== undefined) {
					observedError = {
						code: event.error.code,
						message: event.error.message,
					};
				}
				break;
			case "plan":
				if (typeof event.phase === "string") {
					planPhases.add(event.phase);
				}
				break;
			case "agent_spawn": {
				const role = normalizeRole(event.role);
				// 只在日志缺失 spawn 记录时作为兜底计数，见 foldTurn
				if (role === "worker" || role === "task") {
					observedSpawnCounts[role] += 1;
				}
				break;
			}
			default:
				// text/tool_call/tool_result 等瞬态事件不参与结果判定
				break;
		}
	}

	async function finish(
		finishOpts: { aborted?: boolean; planRejected?: boolean } = {},
	): Promise<TelemetryEvent[]> {
		const events = await loadTurnEvents(opts.session.filePath, startTs);
		const finishedAt = now();
		let fold: FoldResult;
		try {
			fold = foldTurn(
				events,
				{
					turnId: opts.turnId,
					features: opts.features,
					emittedAt: new Date(finishedAt).toISOString(),
				},
				observedSpawnCounts,
			);
		} catch {
			// 日志是外部文件，可能有 JSON 合法但形状不符的记录：折叠失败时丢弃本 turn
			// 的明细，只保留 turn_end 结算事件，绝不让遥测异常冒泡到调用方的 finally
			fold = emptyFold();
		}

		const outcome = resolveOutcome({
			aborted: finishOpts.aborted === true,
			planRejected: finishOpts.planRejected === true,
			stopReason,
			observedError: observedError !== undefined,
			sessionErrorCount: fold.errorCount,
			planPhases,
		});

		const turnEnd: TurnEndEvent = {
			eventId: randomUUID(),
			ts: new Date(finishedAt).toISOString(),
			type: "turn_end",
			turnId: opts.turnId,
			sessionId: opts.sessionId,
			planUsed: planPhases.size > 0,
			outcome,
			durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
			mainSteps: fold.mainSteps,
			assistantMessages: fold.assistantMessages,
			workerCount: fold.workerCount,
			taskCount: fold.taskCount,
			inputTokens: fold.inputTokens,
			outputTokens: fold.outputTokens,
			byTier: fold.byTier,
			byModel: fold.byModel,
		};

		// turn_end 必须是最后一条：上报端可以据此结算一个 turn
		return [...fold.events, turnEnd];
	}

	return { start, observe, finish };
}

export function sessionStartEvent(opts: {
	sessionId: string;
	resumed: boolean;
	appVersion: string;
	features?: Settings["features"];
	os?: string;
	nodeVersion?: string;
}): SessionStartEvent {
	return {
		eventId: randomUUID(),
		ts: new Date().toISOString(),
		type: "session_start",
		sessionId: opts.sessionId,
		resumed: opts.resumed,
		appVersion: opts.appVersion,
		...(opts.features === undefined ? {} : { features: opts.features }),
		...(opts.os === undefined ? {} : { os: opts.os }),
		...(opts.nodeVersion === undefined
			? {}
			: { nodeVersion: opts.nodeVersion }),
	};
}

export function sessionEndEvent(opts: {
	sessionId: string;
	startedAt: number;
	turns: number;
	errors: number;
	now?: () => number;
}): SessionEndEvent {
	const now = opts.now ?? Date.now;
	const endedAt = now();
	return {
		eventId: randomUUID(),
		ts: new Date(endedAt).toISOString(),
		type: "session_end",
		sessionId: opts.sessionId,
		durationMs: Math.max(0, Math.round(endedAt - opts.startedAt)),
		turns: opts.turns,
		errors: opts.errors,
	};
}

// 遥测是旁路：会话文件缺失或损坏时按空日志折叠，绝不让采集失败影响 turn 本身
async function loadTurnEvents(
	filePath: string,
	startTs: string,
): Promise<SessionEvent[]> {
	let events: SessionEvent[];
	try {
		events = (await loadSession(filePath)).events;
	} catch {
		return [];
	}
	// meta 没有 ts，直接排除；ISO 时间串可直接按字典序比较
	return events.filter((event) => event.type !== "meta" && event.ts >= startTs);
}

function foldTurn(
	events: SessionEvent[],
	ctx: FoldContext,
	observedSpawnCounts: Record<"worker" | "task", number>,
): FoldResult {
	// 先建 agentId → role 映射：spawn 事件先于对应 agent 的消息落盘
	const roleByAgent = new Map<string, AgentRole>();
	const spawnedWorkers = new Set<string>();
	const spawnedTasks = new Set<string>();
	for (const event of events) {
		if (event.type !== "agent_spawn") {
			continue;
		}
		const role = normalizeRole(event.role);
		if (role === undefined) {
			continue;
		}
		roleByAgent.set(event.agentId, role);
		if (role === "worker") {
			spawnedWorkers.add(event.agentId);
		} else if (role === "task") {
			spawnedTasks.add(event.agentId);
		}
	}

	const folded: TelemetryEvent[] = [];
	const tierTotals = new Map<string, TokenTotals>();
	const modelTotals = new Map<string, TokenTotals>();
	// toolCallId → 最近一条 assistant_msg 里的 tool_call 块（id 全局唯一）
	const pendingCalls = new Map<
		string,
		{ name: string; ts: string; agentId: string }
	>();
	const stepIndexByAgent = new Map<string, number>();
	const featureCounts = new Map<FeatureKey, FeatureCounts>();
	let inputTokens = 0;
	let outputTokens = 0;
	let mainSteps = 0;
	let assistantMessages = 0;
	let errorCount = 0;

	for (const event of events) {
		switch (event.type) {
			case "assistant_msg": {
				const agentRole = resolveAgentRole(event.agentId, roleByAgent);
				const stepIndex = stepIndexByAgent.get(event.agentId) ?? 0;
				stepIndexByAgent.set(event.agentId, stepIndex + 1);

				const input = toTokenCount(event.usage.input);
				const output = toTokenCount(event.usage.output);
				inputTokens += input;
				outputTokens += output;
				addTotals(tierTotals, event.tier, input, output);
				addTotals(modelTotals, event.model, input, output);
				if (agentRole === "main") {
					mainSteps += 1;
				}
				assistantMessages += 1;

				folded.push({
					eventId: randomUUID(),
					ts: event.ts,
					type: "llm_call",
					turnId: ctx.turnId,
					agentId: event.agentId,
					agentRole,
					tier: event.tier,
					model: event.model,
					inputTokens: input,
					outputTokens: output,
					// 日志缺缓存字段时按 0 上报，保持 schema 形状稳定
					cacheReadTokens: toTokenCount(event.usage.cacheRead),
					cacheWriteTokens: toTokenCount(event.usage.cacheWrite),
					stepIndex,
				} satisfies LlmCallEvent);

				for (const block of event.content) {
					if (block.type !== "tool_call") {
						continue;
					}
					pendingCalls.set(block.id, {
						name: block.name,
						ts: event.ts,
						agentId: event.agentId,
					});
					const feature = featureForToolName(block.name);
					if (feature !== undefined) {
						bumpFeature(featureCounts, feature, "toolCalls");
					}
				}
				break;
			}
			case "tool_result": {
				const call = pendingCalls.get(event.toolCallId);
				if (call === undefined) {
					// 调用发生在 turn 开始前（被 startTs 过滤）：没有可信的起点，不计时
					break;
				}
				folded.push({
					eventId: randomUUID(),
					ts: event.ts,
					type: "tool_call",
					turnId: ctx.turnId,
					agentRole: resolveAgentRole(
						event.agentId ?? call.agentId,
						roleByAgent,
					),
					toolName: call.name,
					// 会话日志没有独立的调用开始时间，用 assistant_msg → tool_result 近似
					durationMs: elapsedMs(call.ts, event.ts),
					durationApprox: true,
					isError: event.isError,
				} satisfies ToolCallEvent);
				break;
			}
			case "error": {
				errorCount += 1;
				folded.push({
					eventId: randomUUID(),
					ts: event.ts,
					type: "error",
					turnId: ctx.turnId,
					// v1 会话错误事件没有 phase 字段，这里统一记为 turn 级错误
					phase: "turn",
					code: event.code,
					sanitizedMessage: sanitizeErrorMessage(event.message),
					agentId: event.agentId,
					agentRole: resolveAgentRole(event.agentId, roleByAgent),
				} satisfies ErrorEvent);
				break;
			}
			default: {
				const feature = featureForSessionEvent(event);
				if (feature !== undefined) {
					bumpFeature(featureCounts, feature, "events");
				}
				break;
			}
		}
	}

	// 只为本 turn 实际用到的功能发 feature_usage；enabled 反映当时的功能开关状态
	for (const feature of FEATURE_KEYS) {
		const counts = featureCounts.get(feature);
		if (counts === undefined || counts.events + counts.toolCalls === 0) {
			continue;
		}
		folded.push({
			eventId: randomUUID(),
			ts: ctx.emittedAt,
			type: "feature_usage",
			feature,
			enabled: featureEnabled(ctx.features, feature),
			events: counts.events,
			toolCalls: counts.toolCalls,
		} satisfies FeatureUsageEvent);
	}

	return {
		events: folded,
		inputTokens,
		outputTokens,
		mainSteps,
		assistantMessages,
		// 日志里没有 spawn 记录时（如写入失败）退回观察到的 spawn 次数，避免规模被低估
		workerCount:
			spawnedWorkers.size > 0
				? spawnedWorkers.size
				: observedSpawnCounts.worker,
		taskCount:
			spawnedTasks.size > 0 ? spawnedTasks.size : observedSpawnCounts.task,
		errorCount,
		byTier: Object.fromEntries(tierTotals),
		byModel: Object.fromEntries(modelTotals),
	};
}

// outcome 优先级：aborted > error > success。工具 isError 不算 turn 失败（agent 可恢复）。
// success 必须显式观察到 done(stop)：done(tool_calls) 只是中间态，未观察到 done
// （编排器异常退出等）按「回合意外结束」判 error，与设计文档 §5.4 一致。
function resolveOutcome(input: {
	aborted: boolean;
	planRejected: boolean;
	stopReason: string | undefined;
	observedError: boolean;
	sessionErrorCount: number;
	planPhases: Set<string>;
}): TurnOutcome {
	if (input.aborted || input.stopReason === "aborted") {
		return "aborted";
	}
	if (input.planRejected && input.planPhases.has("denied")) {
		return "aborted";
	}
	if (
		input.observedError ||
		input.sessionErrorCount > 0 ||
		input.stopReason === "error" ||
		input.stopReason === "max_tokens" ||
		input.planPhases.has("revision_exhausted")
	) {
		return "error";
	}
	return input.stopReason === "stop" ? "success" : "error";
}

// 折叠异常时的最小安全结果：不发任何明细，只让 turn_end 以零值结算
function emptyFold(): FoldResult {
	return {
		events: [],
		inputTokens: 0,
		outputTokens: 0,
		mainSteps: 0,
		assistantMessages: 0,
		workerCount: 0,
		taskCount: 0,
		errorCount: 0,
		byTier: {},
		byModel: {},
	};
}

function normalizeRole(role: string | undefined): AgentRole | undefined {
	if (role === "main" || role === "worker" || role === "task") {
		return role;
	}
	return undefined;
}

// 优先用 agent_spawn 里记录的 role；旧日志没有 spawn 时按 agentId 前缀推断；
// tool_result 默认 agentId 的 v1 语义视为主 agent
function resolveAgentRole(
	agentId: string | undefined,
	roleByAgent: Map<string, AgentRole>,
): AgentRole {
	if (agentId !== undefined) {
		const known = roleByAgent.get(agentId);
		if (known !== undefined) {
			return known;
		}
		if (agentId === "main") {
			return "main";
		}
		if (agentId.startsWith("worker")) {
			return "worker";
		}
		if (agentId.startsWith("task")) {
			return "task";
		}
	}
	return "main";
}

function featureForSessionEvent(event: SessionEvent): FeatureKey | undefined {
	switch (event.type) {
		case "todo/set":
			return "todo";
		case "hook/fired":
			return "hooks";
		case "skill/loaded":
			return "skills";
		case "prompt/invoked":
			return "promptTemplates";
		case "mcp/attached":
			return "mcp";
		default:
			return undefined;
	}
}

function featureForToolName(name: string): FeatureKey | undefined {
	switch (name) {
		case "todo":
			return "todo";
		case "web_search":
			return "webSearch";
		case "web_fetch":
			return "webFetch";
		default:
			return name.startsWith("mcp__") ? "mcp" : undefined;
	}
}

function bumpFeature(
	counts: Map<FeatureKey, FeatureCounts>,
	feature: FeatureKey,
	field: "events" | "toolCalls",
): void {
	const current = counts.get(feature) ?? { events: 0, toolCalls: 0 };
	current[field] += 1;
	counts.set(feature, current);
}

function addTotals(
	totals: Map<string, TokenTotals>,
	key: string,
	input: number,
	output: number,
): void {
	const current = totals.get(key) ?? { input: 0, output: 0 };
	current.input += input;
	current.output += output;
	totals.set(key, current);
}

// 防御异常 usage：缺字段、NaN、负数一律按 0 计，保证事件始终满足 schema
function toTokenCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return Math.floor(value);
}

function elapsedMs(fromTs: string, toTs: string): number {
	const delta = Date.parse(toTs) - Date.parse(fromTs);
	if (!Number.isFinite(delta) || delta <= 0) {
		return 0;
	}
	return Math.round(delta);
}
