// 遥测事件契约（schemaVersion = 1）：字段是严格白名单，只允许数量、耗时、模型名等匿名指标。
// 明确禁止 prompt/回复文本、工具入参/输出、文件内容、文件路径、命令、URL、用户名、仓库名。
// 每个对象都用 .strict()，未知字段直接判为非法，避免上报端悄悄夹带新内容。

import { z } from "zod";

export const SCHEMA_VERSION = 1;

export type TelemetryKind = "user" | "benchmark";
export type TurnOutcome = "success" | "error" | "aborted";
export type AgentRole = "main" | "worker" | "task";
export type ModelTier = "high" | "medium" | "low";

// M4 功能开关快照：只上报开关状态，不上报具体内容
export interface TelemetryFeatureFlags {
	todo?: boolean;
	hooks?: boolean;
	skills?: boolean;
	promptTemplates?: boolean;
	webSearch?: boolean;
	webFetch?: boolean;
	mcp?: boolean;
}

// token 汇总：byTier/byModel 的值，以及 turn_end 的拆分维度
export interface TokenTotals {
	input: number;
	output: number;
}

interface EventBase {
	eventId: string;
	ts: string;
}

export interface SessionStartEvent extends EventBase {
	type: "session_start";
	sessionId: string;
	resumed: boolean;
	appVersion: string;
	os?: string;
	nodeVersion?: string;
	features?: TelemetryFeatureFlags;
}

export interface SessionEndEvent extends EventBase {
	type: "session_end";
	sessionId: string;
	durationMs: number;
	turns: number;
	errors: number;
	appVersion?: string;
	os?: string;
	nodeVersion?: string;
	features?: TelemetryFeatureFlags;
}

export interface TurnStartEvent extends EventBase {
	type: "turn_start";
	turnId: string;
	sessionId: string;
	planUsed?: boolean;
}

// totals 覆盖该用户 turn 的整棵 agent 树（main + worker + task）
export interface TurnEndEvent extends EventBase {
	type: "turn_end";
	turnId: string;
	sessionId: string;
	planUsed: boolean;
	outcome: TurnOutcome;
	durationMs: number;
	mainSteps: number;
	assistantMessages: number;
	workerCount: number;
	taskCount: number;
	inputTokens: number;
	outputTokens: number;
	byTier: Record<string, TokenTotals>;
	byModel: Record<string, TokenTotals>;
}

// 会话日志的 usage 不含缓存字段时按 0 上报，保持字段形状稳定
export interface LlmCallEvent extends EventBase {
	type: "llm_call";
	turnId: string;
	agentId: string;
	agentRole: AgentRole;
	tier: ModelTier;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	stepIndex: number;
}

export interface ToolCallEvent extends EventBase {
	type: "tool_call";
	turnId: string;
	agentRole: AgentRole;
	toolName: string;
	durationMs: number;
	durationApprox: boolean;
	isError: boolean;
}

export interface ErrorEvent extends EventBase {
	type: "error";
	turnId: string;
	phase: string;
	code: string;
	sanitizedMessage: string;
	agentId?: string;
	agentRole?: AgentRole;
	toolName?: string;
	tier?: ModelTier;
	model?: string;
}

export interface FeatureUsageEvent extends EventBase {
	type: "feature_usage";
	feature: string;
	enabled: boolean;
	events: number;
	toolCalls: number;
}

export interface BenchmarkRunEvent extends EventBase {
	type: "benchmark_run";
	benchmark: string;
	dataset: string;
	split: string;
	instanceId: string;
	passed: boolean;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
}

export type TelemetryEvent =
	| SessionStartEvent
	| SessionEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| LlmCallEvent
	| ToolCallEvent
	| ErrorEvent
	| FeatureUsageEvent
	| BenchmarkRunEvent;

const countSchema = z.number().int().nonnegative();
const durationSchema = z.number().nonnegative();

const featureFlagsSchema = z
	.object({
		todo: z.boolean().optional(),
		hooks: z.boolean().optional(),
		skills: z.boolean().optional(),
		promptTemplates: z.boolean().optional(),
		webSearch: z.boolean().optional(),
		webFetch: z.boolean().optional(),
		mcp: z.boolean().optional(),
	})
	.strict();

const tokenTotalsSchema = z
	.object({
		input: countSchema,
		output: countSchema,
	})
	.strict();

const sessionStartSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("session_start"),
		sessionId: z.string(),
		resumed: z.boolean(),
		appVersion: z.string(),
		os: z.string().optional(),
		nodeVersion: z.string().optional(),
		features: featureFlagsSchema.optional(),
	})
	.strict();

const sessionEndSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("session_end"),
		sessionId: z.string(),
		durationMs: durationSchema,
		turns: countSchema,
		errors: countSchema,
		appVersion: z.string().optional(),
		os: z.string().optional(),
		nodeVersion: z.string().optional(),
		features: featureFlagsSchema.optional(),
	})
	.strict();

const turnStartSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("turn_start"),
		turnId: z.string(),
		sessionId: z.string(),
		planUsed: z.boolean().optional(),
	})
	.strict();

const turnEndSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("turn_end"),
		turnId: z.string(),
		sessionId: z.string(),
		planUsed: z.boolean(),
		outcome: z.enum(["success", "error", "aborted"]),
		durationMs: durationSchema,
		mainSteps: countSchema,
		assistantMessages: countSchema,
		workerCount: countSchema,
		taskCount: countSchema,
		inputTokens: countSchema,
		outputTokens: countSchema,
		byTier: z.record(z.string(), tokenTotalsSchema),
		byModel: z.record(z.string(), tokenTotalsSchema),
	})
	.strict();

const llmCallSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("llm_call"),
		turnId: z.string(),
		agentId: z.string(),
		agentRole: z.enum(["main", "worker", "task"]),
		tier: z.enum(["high", "medium", "low"]),
		model: z.string(),
		inputTokens: countSchema,
		outputTokens: countSchema,
		cacheReadTokens: countSchema,
		cacheWriteTokens: countSchema,
		stepIndex: countSchema,
	})
	.strict();

const toolCallSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("tool_call"),
		turnId: z.string(),
		agentRole: z.enum(["main", "worker", "task"]),
		toolName: z.string(),
		durationMs: durationSchema,
		durationApprox: z.boolean(),
		isError: z.boolean(),
	})
	.strict();

const errorSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("error"),
		turnId: z.string(),
		phase: z.string(),
		code: z.string(),
		sanitizedMessage: z.string(),
		agentId: z.string().optional(),
		agentRole: z.enum(["main", "worker", "task"]).optional(),
		toolName: z.string().optional(),
		tier: z.enum(["high", "medium", "low"]).optional(),
		model: z.string().optional(),
	})
	.strict();

const featureUsageSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("feature_usage"),
		feature: z.string(),
		enabled: z.boolean(),
		events: countSchema,
		toolCalls: countSchema,
	})
	.strict();

const benchmarkRunSchema = z
	.object({
		eventId: z.string(),
		ts: z.string(),
		type: z.literal("benchmark_run"),
		benchmark: z.string(),
		dataset: z.string(),
		split: z.string(),
		instanceId: z.string(),
		passed: z.boolean(),
		durationMs: durationSchema,
		inputTokens: countSchema,
		outputTokens: countSchema,
	})
	.strict();

export const telemetryEventSchema = z.discriminatedUnion("type", [
	sessionStartSchema,
	sessionEndSchema,
	turnStartSchema,
	turnEndSchema,
	llmCallSchema,
	toolCallSchema,
	errorSchema,
	featureUsageSchema,
	benchmarkRunSchema,
]);

export type TelemetryEventSchema = z.infer<typeof telemetryEventSchema>;

export const telemetryBatchSchema = z
	.object({
		schemaVersion: z.literal(SCHEMA_VERSION),
		kind: z.enum(["user", "benchmark"]),
		appVersion: z.string(),
		installId: z.string().uuid(),
		events: z.array(telemetryEventSchema).max(500),
	})
	.strict();

export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;
