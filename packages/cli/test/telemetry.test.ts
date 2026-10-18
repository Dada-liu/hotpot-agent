// runChat 遥测接线测试：注入假 fetch，验证每个 turn 的上报内容与关闭语义。
// 全程不触网：telemetryFetch 捕获请求体，会话与安装 ID 都落在临时 home。
// 重点断言两件事：批次符合 schema（kind=user、turn_end success），且线路上没有对话文本。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelInfo, type StreamEvent, scriptedAdapter } from "@hotpot/ai";
import type { Settings } from "@hotpot/core";
import { telemetryBatchSchema } from "@hotpot/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatInput, type ChatOutput, runChat } from "../src/chat.ts";

let home: string;
let oldEnvHome: string | undefined;
let oldEnvEndpoint: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-cli-telemetry-"));
	oldEnvHome = process.env.HOTPOT_HOME;
	oldEnvEndpoint = process.env.HOTPOT_TELEMETRY_ENDPOINT;
	process.env.HOTPOT_HOME = home;
	// 环境变量会参与 endpoint 解析，测试期间必须先清掉，避免宿主环境影响断言
	delete process.env.HOTPOT_TELEMETRY_ENDPOINT;
});

afterEach(async () => {
	if (oldEnvHome === undefined) {
		delete process.env.HOTPOT_HOME;
	} else {
		process.env.HOTPOT_HOME = oldEnvHome;
	}
	if (oldEnvEndpoint === undefined) {
		delete process.env.HOTPOT_TELEMETRY_ENDPOINT;
	} else {
		process.env.HOTPOT_TELEMETRY_ENDPOINT = oldEnvEndpoint;
	}
	await rm(home, { recursive: true, force: true });
});

const SETTINGS: Settings = {
	models: {
		high: { provider: "test", model: "test-model", apiKey: "test-key" },
		medium: { provider: "test", model: "test-model-medium", apiKey: "k" },
		low: { provider: "test", model: "test-model-low", apiKey: "k" },
	},
};

const TEST_MODEL: ModelInfo = {
	id: "test-model",
	provider: "test",
	api: "openai-completions",
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0 },
};

const USER_PROMPT = "帮我看看这个仓库的结构";
const ASSISTANT_TEXT = "已看过仓库结构，主要分为四个包";

class ScriptedInput implements ChatInput {
	private lines: string[];
	private handler: (() => void) | null = null;

	constructor(lines: string[]) {
		this.lines = [...lines];
	}

	readLine(): Promise<string | null> {
		return Promise.resolve(this.lines.shift() ?? null);
	}

	setInterruptHandler(cb: (() => void) | null): void {
		this.handler = cb;
	}

	interrupt(): void {
		this.handler?.();
	}

	close(): void {}
}

class CollectedOutput implements ChatOutput {
	text = "";

	write(s: string): void {
		this.text += s;
	}
}

interface CapturedRequest {
	url: string;
	body: unknown;
}

// 假 fetch：记录 URL 与 JSON 请求体，永远返回 200，绝不出网
function createFakeFetch(): {
	fetchImpl: typeof fetch;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		requests.push({
			url: String(input),
			body: JSON.parse(String(init?.body)) as unknown,
		});
		return new Response("{}", { status: 200 });
	};
	return { fetchImpl, requests };
}

function toolCallRound(
	id: string,
	name: string,
	inputJson: string,
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 5, output: 3 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

function textRound(text: string): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input: 2, output: 1 } },
		{ type: "finish", reason: "stop" },
	];
}

// 一轮完整的短对话：main delegate → worker 处理 → main 收尾
function oneTurnScript(): StreamEvent[][] {
	return [
		toolCallRound(
			"m-tc-1",
			"delegate",
			JSON.stringify({
				difficulty: "simple",
				modelTier: "low",
				task: USER_PROMPT,
			}),
		),
		textRound(ASSISTANT_TEXT),
		textRound(ASSISTANT_TEXT),
	];
}

async function runOneTurn(
	settings: Settings,
	telemetryFetch: typeof fetch,
): Promise<void> {
	await runChat({
		cwd: home,
		home,
		settings,
		llm: {
			adapter: scriptedAdapter(oneTurnScript()),
			model: TEST_MODEL,
		},
		input: new ScriptedInput([USER_PROMPT, "/exit"]),
		output: new CollectedOutput(),
		telemetryFetch,
	});
}

describe("runChat telemetry", () => {
	it("每个 turn 上报匿名批次，且不包含对话文本", async () => {
		const { fetchImpl, requests } = createFakeFetch();
		await runOneTurn(
			{
				...SETTINGS,
				telemetry: {
					enabled: true,
					endpoint: "https://telemetry.example",
				},
			},
			fetchImpl,
		);

		expect(requests.length).toBeGreaterThan(0);
		const batches = requests.map((request) =>
			telemetryBatchSchema.parse(request.body),
		);
		for (const batch of batches) {
			expect(batch.kind).toBe("user");
		}
		const events = batches.flatMap((batch) => batch.events);
		expect(events.some((event) => event.type === "session_start")).toBe(true);
		expect(
			events.some(
				(event) => event.type === "turn_end" && event.outcome === "success",
			),
		).toBe(true);
		expect(
			events.some((event) => event.type === "session_end" && event.turns === 1),
		).toBe(true);

		const wire = JSON.stringify(requests.map((request) => request.body));
		expect(wire).not.toContain(USER_PROMPT);
		expect(wire).not.toContain(ASSISTANT_TEXT);
	});

	it("settings.telemetry.enabled 为 false 时不发任何请求", async () => {
		const { fetchImpl, requests } = createFakeFetch();
		await runOneTurn(
			{
				...SETTINGS,
				telemetry: {
					enabled: false,
					endpoint: "https://telemetry.example",
				},
			},
			fetchImpl,
		);

		expect(requests).toEqual([]);
	});

	it("endpoint 为空时不发任何请求", async () => {
		const { fetchImpl, requests } = createFakeFetch();
		await runOneTurn(
			{
				...SETTINGS,
				telemetry: { enabled: true, endpoint: "" },
			},
			fetchImpl,
		);

		expect(requests).toEqual([]);
	});

	it("endpoint 非法时不发任何请求", async () => {
		const { fetchImpl, requests } = createFakeFetch();
		await runOneTurn(
			{
				...SETTINGS,
				telemetry: { enabled: true, endpoint: "ftp://telemetry.example" },
			},
			fetchImpl,
		);

		expect(requests).toEqual([]);
	});
});
