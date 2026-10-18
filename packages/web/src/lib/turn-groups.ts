// 对话区回合分组：transcript 按 user 消息切成组，供 ChatView 做左右布局与过程区折叠。
// 纯函数，node 下可单测。

import type { TranscriptEntry } from "../state/reducer.ts";

export interface TurnGroup {
	// 组标识 = 组内首条条目 id（React key 用）
	id: string;
	// 组首的 user 消息（重放里可能没有 user 条目，此时为 null）
	user: Extract<TranscriptEntry, { kind: "user" }> | null;
	// user 之后、下一条 user 之前的全部条目（assistant/tool/plan/approval/error）
	items: TranscriptEntry[];
}

export function groupTranscript(transcript: TranscriptEntry[]): TurnGroup[] {
	const groups: TurnGroup[] = [];
	for (const entry of transcript) {
		if (entry.kind === "user") {
			groups.push({ id: entry.id, user: entry, items: [] });
			continue;
		}
		const last = groups[groups.length - 1];
		if (last === undefined) {
			groups.push({ id: entry.id, user: null, items: [entry] });
		} else {
			last.items.push(entry);
		}
	}
	return groups;
}

// 最终回答：最后一个「含文本块且不含 tool_call 块」的 assistant 条目。
// 带 tool_call 的 assistant 文本视为思考内容，不落最终回答。
export function isFinalAnswer(entry: TranscriptEntry): boolean {
	if (entry.kind !== "assistant") {
		return false;
	}
	const hasText = entry.content.some((b) => b.type === "text");
	const hasToolCall = entry.content.some((b) => b.type === "tool_call");
	return hasText && !hasToolCall;
}

export function findFinalAnswer(
	items: TranscriptEntry[],
): TranscriptEntry | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		if (isFinalAnswer(items[i])) {
			return items[i];
		}
	}
	return undefined;
}

// 过程区条目：思考（assistant 文本）与工具卡片；plan/approval/error 属于常驻交互区
export function isProcessItem(entry: TranscriptEntry): boolean {
	return entry.kind === "assistant" || entry.kind === "tool";
}
