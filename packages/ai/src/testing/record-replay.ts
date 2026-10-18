// 录制/回放测试辅助：把一次真实或脚本适配器的 streamChat 事件序列落成 JSONL，
// 之后离线回放同一序列，便于把一次真实 LLM 交互固化成 hermetic 测试。
// 格式：每次 streamChat 一行 {"request": ChatRequest, "events": StreamEvent[]}。
// 录制文件是本地测试 fixture：不要提交含真实用户 prompt/回复的录制。
// 回放按调用顺序消费；超出录制条数时在迭代期抛错（与真实适配器的异步失败方式一致）。

import { appendFile, readFile } from "node:fs/promises";
import type { ChatRequest, LlmAdapter, StreamEvent } from "../types.ts";

export interface RecordedCall {
	request: ChatRequest;
	events: StreamEvent[];
}

export function createRecordingAdapter(
	inner: LlmAdapter,
	file: string,
): LlmAdapter {
	return {
		api: inner.api,
		streamChat(
			request: ChatRequest,
			signal: AbortSignal,
		): AsyncIterable<StreamEvent> {
			return (async function* (): AsyncGenerator<StreamEvent> {
				const events: StreamEvent[] = [];
				for await (const event of inner.streamChat(request, signal)) {
					events.push(event);
					yield event;
				}
				// 只有完整消费完一轮才落盘；中途 abort 的半轮录制没有回放价值
				await appendFile(file, `${JSON.stringify({ request, events })}\n`);
			})();
		},
	};
}

export function createReplayAdapter(file: string): LlmAdapter {
	let calls: Promise<RecordedCall[]> | undefined;
	let cursor = 0;

	return {
		api: "replay",
		streamChat(
			_request: ChatRequest,
			_signal: AbortSignal,
		): AsyncIterable<StreamEvent> {
			return (async function* (): AsyncGenerator<StreamEvent> {
				calls ??= loadRecording(file);
				const loaded = await calls;
				const call = loaded[cursor];
				cursor += 1;
				if (call === undefined) {
					throw new Error(
						`replay adapter exhausted: ${file} has ${loaded.length} call(s)`,
					);
				}
				for (const event of call.events) {
					yield event;
				}
			})();
		},
	};
}

async function loadRecording(file: string): Promise<RecordedCall[]> {
	const text = await readFile(file, "utf8");
	const lines = text.split("\n");
	const calls: RecordedCall[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim() === "") {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			throw new Error(`invalid recording at ${file}:${index + 1}: not JSON`);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(
				`invalid recording at ${file}:${index + 1}: expected an object`,
			);
		}
		const record = parsed as Record<string, unknown>;
		if (
			typeof record.request !== "object" ||
			record.request === null ||
			!Array.isArray(record.events)
		) {
			throw new Error(
				`invalid recording at ${file}:${index + 1}: missing request/events`,
			);
		}
		calls.push({
			request: record.request as unknown as ChatRequest,
			events: record.events as StreamEvent[],
		});
	}
	return calls;
}
