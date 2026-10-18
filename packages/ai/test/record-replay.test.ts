// 录制/回放适配器测试：scriptedAdapter 产生事件 → 录制到临时 JSONL →
// 回放得到逐事件相同的事件流；回放次数超过录制条数时在迭代期抛错。
// 全本地文件，不触网。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRecordingAdapter,
	createReplayAdapter,
} from "../src/testing/record-replay.ts";
import { scriptedAdapter } from "../src/testing/scripted-adapter.ts";
import type { ChatRequest, ModelInfo, StreamEvent } from "../src/types.ts";

let dir: string;

const MODEL: ModelInfo = {
	id: "test-model",
	provider: "test",
	api: "openai-completions",
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0 },
};

const REQUEST: ChatRequest = {
	model: MODEL,
	apiKey: "test-key",
	system: "You are a test.",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
	tools: [],
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-ai-record-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function textRound(text: string): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input: 3, output: 1 } },
		{ type: "finish", reason: "stop" },
	];
}

async function collect(adapter: {
	streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of adapter.streamChat(
		REQUEST,
		new AbortController().signal,
	)) {
		events.push(event);
	}
	return events;
}

describe("record and replay adapter", () => {
	it("录制后回放出完全相同的事件流", async () => {
		const file = join(dir, "recording.jsonl");
		const recording = createRecordingAdapter(
			scriptedAdapter([textRound("hello")]),
			file,
		);
		const live = await collect(recording);
		expect(live).toEqual(textRound("hello"));

		const replay = createReplayAdapter(file);
		const replayed = await collect(replay);
		expect(replayed).toEqual(live);
	});

	it("回放耗尽后在迭代时抛错", async () => {
		const file = join(dir, "empty.jsonl");
		await writeFile(
			file,
			`${JSON.stringify({ request: REQUEST, events: textRound("once") })}\n`,
		);
		const replay = createReplayAdapter(file);
		expect(await collect(replay)).toEqual(textRound("once"));
		await expect(collect(replay)).rejects.toThrow(/replay adapter exhausted/);
	});
});
