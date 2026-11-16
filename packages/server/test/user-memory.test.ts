// Server 跨会话记忆验收：新会话与 attachById 恢复会话都经真实 ChatRequest 读取 MEMORY.md
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type LlmAdapter,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
} from "@hotpot/ai";
import type { Settings } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSessionManager,
	type SessionManager,
} from "../src/session-manager.ts";
import type { WireEvent } from "../src/wire.ts";

let home: string;
let cwd: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-server-user-memory-home-"));
	cwd = await mkdtemp(join(tmpdir(), "hotpot-server-user-memory-cwd-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

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

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function sendAndWait(
	manager: SessionManager,
	id: string,
	message: string,
): Promise<void> {
	const events: WireEvent[] = [];
	const unsubscribe = manager.subscribe(id, null, (event) =>
		events.push(event),
	);
	const countEnds = () =>
		events.filter((event) => event.kind === "turn" && event.phase === "end")
			.length;
	const initialEnds = countEnds();
	try {
		await manager.send(id, message);
		await waitFor(() => countEnds() > initialEnds);
	} finally {
		unsubscribe();
	}
}

describe("server user memory across sessions", () => {
	it("会话 A 保存后，新会话 B 与恢复会话的首个真实 ChatRequest.system 均含记忆", async () => {
		const settings: Settings = {
			models: {
				high: { provider: "test", model: "test-high", apiKey: "hk" },
				medium: { provider: "test", model: "test-medium", apiKey: "mk" },
				low: { provider: "test", model: "test-low", apiKey: "lk" },
			},
			permission: { mode: "full" },
			features: {
				memory: true,
				hooks: false,
				skills: false,
				promptTemplates: false,
				mcp: false,
			},
			telemetry: { enabled: false },
		};
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify(settings),
			"utf8",
		);
		const requests: ChatRequest[] = [];
		const inner = scriptedAdapter([
			memorySaveRound("The user prefers stable Markdown memory."),
			textRound("Saved in A."),
			textRound("Answered in B."),
			textRound("Answered after resume."),
		]);
		const adapter: LlmAdapter = {
			api: inner.api,
			streamChat(request, signal) {
				requests.push(request);
				return inner.streamChat(request, signal);
			},
		};
		const manager = createSessionManager({
			home,
			llm: { adapter, model: MODEL },
		});
		const sessionA = await manager.create(cwd);
		let sessionBId: string | undefined;
		try {
			await sendAndWait(manager, sessionA.id, "Remember this preference");
			expect(await readFile(join(home, "MEMORY.md"), "utf8")).toContain(
				"The user prefers stable Markdown memory.",
			);
			await manager.close(sessionA.id);

			const sessionB = await manager.create(cwd);
			sessionBId = sessionB.id;
			await sendAndWait(manager, sessionB.id, "Answer in session B");
			expect(requests).toHaveLength(3);
			expect(requests[2]?.system).toContain(
				"The user prefers stable Markdown memory.",
			);

			const resumed = await manager.attachById(sessionA.id);
			expect(resumed).not.toBeNull();
			if (resumed === null) throw new Error("恢复会话失败");
			await sendAndWait(manager, resumed.id, "Answer after resume");
			expect(requests).toHaveLength(4);
			expect(requests[3]?.system).toContain(
				"The user prefers stable Markdown memory.",
			);
		} finally {
			for (const id of [sessionA.id, sessionBId]) {
				if (id !== undefined && manager.get(id) !== null) {
					await manager.close(id);
				}
			}
		}
	});
});
