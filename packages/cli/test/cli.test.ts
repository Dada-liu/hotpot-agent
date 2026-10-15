import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type LlmAdapter,
	type ModelInfo,
	type StreamEvent,
	scriptedAdapter,
} from "@hotpot/ai";
import {
	createSession,
	listSessions,
	loadSession,
	type Settings,
} from "@hotpot/core";
import { resolveModel } from "@hotpot/orchestrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ChatInput,
	type ChatOutput,
	parseChatArgs,
	runChat,
} from "../src/chat.ts";

// 每个用例一个临时 home（同时写进 HOTPOT_HOME，贴近真实运行条件）
let home: string;
let oldEnvHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-cli-test-"));
	oldEnvHome = process.env.HOTPOT_HOME;
	process.env.HOTPOT_HOME = home;
});

afterEach(async () => {
	if (oldEnvHome === undefined) {
		delete process.env.HOTPOT_HOME;
	} else {
		process.env.HOTPOT_HOME = oldEnvHome;
	}
	await rm(home, { recursive: true, force: true });
});

const TS = "2026-10-10T08:00:00.000Z";

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

// 脚本化输入：按队列逐行返回，耗尽后返回 null（EOF）；interrupt 模拟 Ctrl-C
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

// 收集输出为字符串；onWrite 钩子供「输出出现某文本时中断」类用例使用
class CollectedOutput implements ChatOutput {
	text = "";
	onWrite?: (s: string) => void;

	write(s: string): void {
		this.text += s;
		this.onWrite?.(s);
	}
}

function textRound(text: string): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input: 2, output: 1 } },
		{ type: "finish", reason: "stop" },
	];
}

describe("runChat", () => {
	it("问→答→/exit：输出含回答文本，且生成了会话文件", async () => {
		const input = new ScriptedInput(["你好", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: {
				adapter: scriptedAdapter([textRound("你好，世界")]),
				model: TEST_MODEL,
			},
			input,
			output,
		});

		expect(output.text).toContain("你好，世界");
		const sessions = await listSessions(home);
		expect(sessions).toHaveLength(1);
		const { events } = await loadSession(sessions[0]?.filePath ?? "");
		expect(events.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
		]);
	});

	it("危险命令触发审批：回答 n 拒绝执行，渲染 isError 摘要", async () => {
		const script: StreamEvent[][] = [
			[
				{ type: "tool_call_start", id: "tc-1", name: "bash" },
				{
					type: "tool_call_delta",
					id: "tc-1",
					inputDelta: '{"command":"rm -rf /tmp/hotpot-cli-test-target"}',
				},
				{ type: "tool_call_end", id: "tc-1" },
				{ type: "usage", usage: { input: 5, output: 3 } },
				{ type: "finish", reason: "tool_calls" },
			],
			textRound("已取消操作"),
		];
		const input = new ScriptedInput(["清理临时目录", "n", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: { adapter: scriptedAdapter(script), model: TEST_MODEL },
			input,
			output,
		});

		expect(output.text).toContain("[tool] bash(");
		expect(output.text).toContain("rm -rf");
		expect(output.text).toContain("[approval]");
		expect(output.text).toContain("已拒绝");
		// bash 工具 deny 路径的 tool_result 文本
		expect(output.text).toContain("denied");
		expect(output.text).toContain("已取消操作");
	});

	it("approval policy=never：不询问，危险操作 fail-closed 直接 deny", async () => {
		const settings: Settings = {
			...SETTINGS,
			approval: { policy: "never" },
		};
		const script: StreamEvent[][] = [
			[
				{ type: "tool_call_start", id: "tc-1", name: "bash" },
				{
					type: "tool_call_delta",
					id: "tc-1",
					inputDelta: '{"command":"rm -rf /tmp/hotpot-cli-test-target"}',
				},
				{ type: "tool_call_end", id: "tc-1" },
				{ type: "usage", usage: { input: 5, output: 3 } },
				{ type: "finish", reason: "tool_calls" },
			],
			textRound("已跳过危险操作"),
		];
		// 输入队列不含审批回答：若仍发起询问会消费掉 /exit 导致用例失败
		const input = new ScriptedInput(["清理临时目录", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings,
			llm: { adapter: scriptedAdapter(script), model: TEST_MODEL },
			input,
			output,
		});

		expect(output.text).not.toContain("[approval]");
		expect(output.text).toContain("denied");
		expect(output.text).toContain("已跳过危险操作");
	});

	it("approval policy=always：安全命令也先询问，回答 y 放行执行", async () => {
		const settings: Settings = {
			...SETTINGS,
			approval: { policy: "always" },
		};
		const script: StreamEvent[][] = [
			[
				{ type: "tool_call_start", id: "tc-1", name: "bash" },
				{
					type: "tool_call_delta",
					id: "tc-1",
					inputDelta: '{"command":"echo policy-always-ok"}',
				},
				{ type: "tool_call_end", id: "tc-1" },
				{ type: "usage", usage: { input: 5, output: 3 } },
				{ type: "finish", reason: "tool_calls" },
			],
			textRound("执行完毕"),
		];
		const input = new ScriptedInput(["打个招呼", "y", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings,
			llm: { adapter: scriptedAdapter(script), model: TEST_MODEL },
			input,
			output,
		});

		// echo 不是危险命令，ask-on-dangerous 下不会询问；always 下询问并放行
		expect(output.text).toContain("[approval]");
		expect(output.text).toContain("已允许");
		expect(output.text).toContain("policy-always-ok");
		expect(output.text).toContain("执行完毕");
	});

	it("--session 恢复：续聊写入同一文件，首轮请求携带历史消息", async () => {
		const session = await createSession(home, home);
		await session.append({
			type: "user_msg",
			id: "u-old",
			ts: TS,
			agentId: "main",
			content: "之前的问题",
		});

		const requests: ChatRequest[] = [];
		const inner = scriptedAdapter([textRound("续聊回答")]);
		const recording: LlmAdapter = {
			api: inner.api,
			streamChat(req, signal) {
				requests.push(req);
				return inner.streamChat(req, signal);
			},
		};
		const input = new ScriptedInput(["继续", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			sessionPath: session.filePath,
			settings: SETTINGS,
			llm: { adapter: recording, model: TEST_MODEL },
			input,
			output,
		});

		// 同一文件继续追加，不新建会话
		expect(await listSessions(home)).toHaveLength(1);
		const { events } = await loadSession(session.filePath);
		expect(events.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"user_msg",
			"assistant_msg",
		]);
		// 首轮请求即携带恢复出的历史（runTurn 内部 loadSession + deriveMessages）
		expect(requests[0]?.messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "之前的问题" }],
		});
		expect(requests[0]?.messages[1]?.content).toEqual([
			{ type: "text", text: "继续" },
		]);
	});

	it("Ctrl-C 中断当前回合而不退出进程：abort 后循环继续，/exit 正常收尾", async () => {
		// 模拟真实适配器：signal 传入 fetch，abort 使等待中的流以 AbortError rejection 结束
		const hangingAdapter: LlmAdapter = {
			api: "hanging-fake",
			streamChat(_req, signal) {
				return (async function* (): AsyncGenerator<StreamEvent> {
					yield { type: "text_delta", delta: "半截回答" };
					await new Promise<never>((_resolve, reject) => {
						if (signal.aborted) {
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							);
							return;
						}
						signal.addEventListener("abort", () =>
							reject(
								new DOMException("The operation was aborted", "AbortError"),
							),
						);
					});
				})();
			},
		};
		const input = new ScriptedInput(["打个长回合", "/exit"]);
		const output = new CollectedOutput();
		// 回答文本一开始打印就模拟 Ctrl-C
		output.onWrite = (s) => {
			if (s.includes("半截回答")) {
				input.interrupt();
			}
		};
		await runChat({
			cwd: home,
			home,
			settings: SETTINGS,
			llm: { adapter: hangingAdapter, model: TEST_MODEL },
			input,
			output,
		});

		expect(output.text).toContain("半截回答");
		expect(output.text).toContain("[done: aborted]");
		// 中断后 readline 循环继续：第二行 /exit 被消费，正常告别
		expect(output.text).toContain("再见");
	});

	it("tier 缺省取 settings.mainAgentTier", async () => {
		const settings: Settings = {
			...SETTINGS,
			mainAgentTier: "medium",
		};
		const input = new ScriptedInput(["hi", "/exit"]);
		const output = new CollectedOutput();
		await runChat({
			cwd: home,
			home,
			settings,
			llm: { adapter: scriptedAdapter([textRound("ok")]), model: TEST_MODEL },
			input,
			output,
		});
		expect(output.text).toContain("tier=medium");
	});
});

describe("parseChatArgs", () => {
	it("解析 chat 子命令与 --session/--tier", () => {
		expect(parseChatArgs(["chat"])).toEqual({});
		expect(
			parseChatArgs(["chat", "--session", "/tmp/s.jsonl", "--tier", "low"]),
		).toEqual({ sessionPath: "/tmp/s.jsonl", tier: "low" });
	});

	it("非法输入报中文用法错误", () => {
		expect(() => parseChatArgs(["nope"])).toThrow(/未知命令/);
		expect(() => parseChatArgs(["chat", "--tier", "ultra"])).toThrow(/--tier/);
		expect(() => parseChatArgs(["chat", "--session"])).toThrow(/--session/);
		expect(() => parseChatArgs(["chat", "--wat"])).toThrow(/未知参数/);
	});
});

describe("resolveModel", () => {
	it("目录内模型按 ModelInfo.api 选适配器，无告警", () => {
		const resolved = resolveModel({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			apiKey: "k",
		});
		expect(resolved.model.id).toBe("claude-sonnet-4-5");
		expect(resolved.adapter.api).toBe("anthropic-messages");
		expect(resolved.warning).toBeUndefined();
	});

	it("未知模型按 provider 推断协议并给出告警，contextWindow 取 128000", () => {
		const openaiLike = resolveModel({
			provider: "acme",
			model: "acme-1",
			apiKey: "k",
		});
		expect(openaiLike.adapter.api).toBe("openai-completions");
		expect(openaiLike.model.contextWindow).toBe(128000);
		expect(openaiLike.warning).toContain("acme/acme-1");

		const anthropicLike = resolveModel({
			provider: "anthropic",
			model: "claude-future-9",
			apiKey: "k",
		});
		expect(anthropicLike.adapter.api).toBe("anthropic-messages");
		expect(anthropicLike.warning).toBeTruthy();
	});
});
