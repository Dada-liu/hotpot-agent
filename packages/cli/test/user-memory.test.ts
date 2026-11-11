// CLI 跨会话记忆验收：真实 memory_save 写盘后，新会话与恢复会话的首个 ChatRequest 都读取同一 Markdown
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type LlmAdapter,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
} from "@hotpot/ai";
import { listSessions, type Settings } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatInput, type ChatOutput, runChat } from "../src/chat.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-cli-user-memory-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

const SETTINGS: Settings = {
	models: {
		high: { provider: "test", model: "test-high", apiKey: "hk" },
		medium: { provider: "test", model: "test-medium", apiKey: "mk" },
		low: { provider: "test", model: "test-low", apiKey: "lk" },
	},
	features: {
		memory: true,
		hooks: false,
		skills: false,
		promptTemplates: false,
		mcp: false,
	},
	telemetry: { enabled: false },
};

const MODEL: ModelInfo = {
	id: "test-high",
	provider: "test",
	api: "openai-completions",
	contextWindow: 128000,
	maxTokens: 8192,
	cost: { input: 0, output: 0 },
};

function textRound(text: string): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input: 2, output: 1 } },
		{ type: "finish", reason: "stop" },
	];
}

function memorySaveRound(content: string): StreamEvent[] {
	return [
		{ type: "tool_call_start", id: "memory-call", name: "memory_save" },
		{
			type: "tool_call_delta",
			id: "memory-call",
			inputDelta: JSON.stringify({ content }),
		},
		{ type: "tool_call_end", id: "memory-call" },
		{ type: "usage", usage: { input: 2, output: 1 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

function recordingAdapter(script: StreamEvent[][]): {
	adapter: LlmAdapter;
	requests: ChatRequest[];
} {
	const requests: ChatRequest[] = [];
	const inner = scriptedAdapter(script);
	return {
		requests,
		adapter: {
			api: inner.api,
			streamChat(request, signal) {
				requests.push(request);
				return inner.streamChat(request, signal);
			},
		},
	};
}

function input(lines: string[]): ChatInput {
	const queue = [...lines];
	return {
		readLine: () => Promise.resolve(queue.shift() ?? null),
		setInterruptHandler: () => {},
		close: () => {},
	};
}

const output: ChatOutput = { write: () => {} };

describe("CLI user memory across sessions", () => {
	it("会话 A 保存后，新会话 B 与恢复会话的首个真实 ChatRequest.system 均含记忆", async () => {
		const sessionA = recordingAdapter([
			memorySaveRound("The user prefers concise Chinese answers."),
			textRound("Saved."),
		]);
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: { adapter: sessionA.adapter, model: MODEL },
			input: input(["Remember my answer style"]),
			output,
		});
		const [stored] = await listSessions(home);
		expect(stored).toBeDefined();
		expect(await readFile(join(home, "MEMORY.md"), "utf8")).toContain(
			"The user prefers concise Chinese answers.",
		);
		expect(sessionA.requests[0]?.tools.map((tool) => tool.name)).toContain(
			"memory_save",
		);

		const sessionB = recordingAdapter([textRound("New session answer.")]);
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: { adapter: sessionB.adapter, model: MODEL },
			input: input(["Answer in a new session"]),
			output,
		});
		expect(sessionB.requests).toHaveLength(1);
		expect(sessionB.requests[0]?.system).toContain(
			"The user prefers concise Chinese answers.",
		);

		const resumed = recordingAdapter([textRound("Resumed session answer.")]);
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			sessionPath: stored?.filePath,
			llm: { adapter: resumed.adapter, model: MODEL },
			input: input(["Answer after resume"]),
			output,
		});
		expect(resumed.requests).toHaveLength(1);
		expect(resumed.requests[0]?.system).toContain(
			"The user prefers concise Chinese answers.",
		);
	});
});
