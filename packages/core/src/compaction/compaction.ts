import { randomUUID } from "node:crypto";
import {
	type ChatRequest,
	type FinishReason,
	LlmError,
	type Usage,
} from "@hotpot/ai";
import type { LoopConfig } from "../agent/types.ts";
import { featureEnabled } from "../config/config.ts";
import { deriveMessages } from "../session/derive.ts";
import type { SessionEvent } from "../session/events.ts";
import { estimateTokens } from "./estimate.ts";

type CompactionEvent = Extract<SessionEvent, { type: "compaction" }>;

export interface CompactionResult {
	events: SessionEvent[];
	compaction?: CompactionEvent;
}

interface EventGroup {
	events: SessionEvent[];
	throughEventId: string;
}

// 中文注释：摘要提示词要求模型保留后续任务所需的全部事实，不执行工具。
const SUMMARY_PROMPT =
	"Summarize the conversation so far for continuation. Preserve user requests, constraints, decisions, completed work, pending tasks, and relevant tool outcomes. Be concise and do not invent details.";

export async function maybeCompact(
	cfg: LoopConfig,
	system: string,
	events: SessionEvent[],
	signal: AbortSignal,
): Promise<CompactionResult> {
	if (!featureEnabled(cfg.features, "compaction") || signal.aborted) {
		return { events };
	}

	const tools = cfg.registry.declarations();
	const triggerRatio = cfg.compaction?.triggerRatio ?? 0.8;
	const keepRecentTokens = cfg.compaction?.keepRecentTokens ?? 20000;
	const limit = (cfg.model.contextWindow - cfg.model.maxTokens) * triggerRatio;
	if (
		estimateTokens(deriveMessages(events, cfg.agentId), system, tools) <= limit
	) {
		return { events };
	}

	let startIndex = 0;
	let previousSummary: string | undefined;
	for (const [index, event] of events.entries()) {
		if (event.type !== "compaction" || event.agentId !== cfg.agentId) {
			continue;
		}
		const throughIndex = events.findIndex(
			(candidate, candidateIndex) =>
				candidateIndex < index &&
				"id" in candidate &&
				candidate.id === event.throughEventId,
		);
		if (throughIndex >= 0) {
			startIndex = throughIndex + 1;
			previousSummary = event.summary;
		}
	}

	const groups: EventGroup[] = [];
	let current: EventGroup | undefined;
	for (const event of events.slice(startIndex)) {
		const belongs =
			((event.type === "user_msg" ||
				event.type === "internal_msg" ||
				event.type === "assistant_msg") &&
				event.agentId === cfg.agentId) ||
			(event.type === "tool_result" &&
				(event.agentId ?? "main") === cfg.agentId);
		if (!belongs) {
			continue;
		}

		if (event.type === "tool_result" && current) {
			const first = current.events[0];
			const isMatchingResult =
				first?.type === "assistant_msg" &&
				first.content.some(
					(block) =>
						block.type === "tool_call" && block.id === event.toolCallId,
				);
			if (isMatchingResult) {
				current.events.push(event);
				current.throughEventId = event.id;
				continue;
			}
		}

		current = { events: [event], throughEventId: event.id };
		groups.push(current);
	}

	let firstKept = groups.length;
	let retainedTokens =
		previousSummary === undefined
			? 0
			: estimateTokens(
					[
						{
							role: "user",
							content: [{ type: "text", text: previousSummary }],
						},
					],
					"",
					[],
				);
	for (let i = groups.length - 1; i >= 0; i -= 1) {
		const group = groups[i];
		if (!group) {
			continue;
		}
		const groupTokens = estimateTokens(
			deriveMessages(group.events, cfg.agentId),
			"",
			[],
		);
		if (
			firstKept < groups.length &&
			retainedTokens + groupTokens > keepRecentTokens
		) {
			break;
		}
		firstKept = i;
		retainedTokens += groupTokens;
	}

	const compactedGroup = groups[firstKept - 1];
	if (!compactedGroup) {
		throw new LlmError(
			"context remains over the configured limit after retaining recent history",
			"context_limit",
		);
	}
	const throughIndex = events.findIndex(
		(event) => "id" in event && event.id === compactedGroup.throughEventId,
	);
	if (throughIndex < 0) {
		throw new LlmError(
			"compaction retention point is missing",
			"context_limit",
		);
	}

	const req: ChatRequest = {
		model: cfg.model,
		apiKey: cfg.apiKey,
		baseUrl: cfg.baseUrl,
		system,
		messages: [
			...deriveMessages(events.slice(0, throughIndex + 1), cfg.agentId),
			{ role: "user", content: [{ type: "text", text: SUMMARY_PROMPT }] },
		],
		tools: [],
	};
	let text = "";
	let usage: Usage = { input: 0, output: 0 };
	let finish: FinishReason | undefined;
	try {
		for await (const event of cfg.adapter.streamChat(req, signal)) {
			if (signal.aborted) {
				return { events };
			}
			if (event.type === "text_delta") {
				text += event.delta;
			} else if (event.type === "usage") {
				usage = event.usage;
			} else if (event.type === "finish") {
				finish = event.reason;
			}
		}
	} catch (err) {
		if (signal.aborted) {
			return { events };
		}
		throw err instanceof LlmError
			? err
			: new LlmError(
					err instanceof Error ? err.message : String(err),
					"stream_error",
				);
	}
	if (signal.aborted || finish === "aborted") {
		return { events };
	}
	if (finish !== "stop") {
		throw new LlmError(
			finish === undefined
				? "compaction summary ended without a finish event"
				: `compaction summary failed with finish reason ${finish}`,
			finish === undefined ? "truncated_stream" : "stream_error",
		);
	}
	const summary = text.trim();
	if (summary === "") {
		throw new LlmError("compaction summary was empty", "stream_error");
	}

	const compaction: CompactionEvent = {
		type: "compaction",
		id: randomUUID(),
		ts: new Date().toISOString(),
		agentId: cfg.agentId,
		throughEventId: compactedGroup.throughEventId,
		summary,
		usage,
		model: cfg.model.id,
		tier: cfg.tier ?? "high",
	};
	await cfg.session.append(compaction);
	const compactedEvents = [...events, compaction];
	if (
		estimateTokens(
			deriveMessages(compactedEvents, cfg.agentId),
			system,
			tools,
		) > limit
	) {
		throw new LlmError(
			"context remains over the configured limit after compaction",
			"context_limit",
		);
	}
	return { events: compactedEvents, compaction };
}
