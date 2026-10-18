// Feature ① todo 工具端到端测试（scriptedAdapter 回放，不触真实 API）：
// - worker 调 todo → 落盘 todo/set（agentId/todos 快照）→ tool_result 回渲染清单
// - 会话恢复后（resumeSession + 新 runtime）再跑同一 worker：system prompt 折入上次清单
// - 其他 agent（worker-2）的 prompt 不含该清单（fold 按 agentId 隔离）
// - features.todo=false：注册表无 todo 工具，prompt 不出 task-list 段
// 驱动方式与 spawn-tasks 同款：createRuntime + scriptedAdapter，turn 经 runAgentInline。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type LlmAdapter,
	type StreamEvent,
	scriptedAdapter,
	type Usage,
} from "@hotpot/ai";
import {
	ApprovalChain,
	createSession,
	deriveMessages,
	loadSession,
	type ModelTier,
	resumeSession,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkerRegistry } from "../src/registries.ts";
import { createRuntime, type OrchestrationRuntime } from "../src/runtime.ts";
import { runAgentInline } from "../src/tools/run-worker.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-todo-flow-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-todo-flow-proj-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

// 录制包装：记录每次请求的 system/messages，回放走 scriptedAdapter（按全局调用序）
function recordingAdapter(
	script: StreamEvent[][],
	requests: ChatRequest[],
): LlmAdapter {
	const inner = scriptedAdapter(script);
	return {
		api: inner.api,
		streamChat(req, signal) {
			requests.push(req);
			return inner.streamChat(req, signal);
		},
	};
}

async function makeRuntime(
	adapter: LlmAdapter,
	sessionFilePath?: string,
	features?: Settings["features"],
): Promise<OrchestrationRuntime> {
	const session = sessionFilePath
		? await resumeSession(sessionFilePath)
		: await createSession(proj, home);
	const base = createRuntime({
		session,
		cwd: proj,
		approval: new ApprovalChain(),
		models: MODELS,
		features,
	});
	return {
		...base,
		resolveModel(tier: ModelTier) {
			return { ...base.resolveModel(tier), adapter };
		},
	};
}

// 一轮「调用单个工具」的脚本：tool_call_start/delta/end + usage + finish
function toolCallRound(
	name: string,
	id: string,
	inputJson: string,
): StreamEvent[] {
	return [
		{ type: "tool_call_start", id, name },
		{ type: "tool_call_delta", id, inputDelta: inputJson },
		{ type: "tool_call_end", id },
		{ type: "usage", usage: { input: 100, output: 20 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

function textRound(delta: string, usage: Usage): StreamEvent[] {
	return [
		{ type: "text_delta", delta },
		{ type: "usage", usage },
		{ type: "finish", reason: "stop" },
	];
}

const TODO_INPUT =
	'{"todos":[{"content":"read config","status":"completed"},{"content":"patch loader","status":"in_progress"},{"content":"add tests","status":"pending"}]}';

describe("todo 工具端到端（runAgentInline）", () => {
	it("worker 调 todo → 落盘 todo/set 快照，tool_result 回渲染清单", async () => {
		const requests: ChatRequest[] = [];
		const adapter = recordingAdapter(
			[
				toolCallRound("todo", "w-tc-1", TODO_INPUT),
				textRound("清单已更新。", { input: 50, output: 10 }),
			],
			requests,
		);
		const runtime = await makeRuntime(adapter);

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(outcome.failures).toEqual([]);
		expect(outcome.summary).toBe("清单已更新。");

		const { events } = await loadSession(runtime.session.filePath);
		// 落盘 todo/set：agentId 归属 worker-1，todos 为全量快照
		const todoEvents = events.filter(
			(e): e is Extract<SessionEvent, { type: "todo/set" }> =>
				e.type === "todo/set" && e.agentId === "worker-1",
		);
		expect(todoEvents).toHaveLength(1);
		expect(todoEvents[0]?.todos).toEqual([
			{ content: "read config", status: "completed" },
			{ content: "patch loader", status: "in_progress" },
			{ content: "add tests", status: "pending" },
		]);
		// todo/set 不进模型历史：derive 只折 user/assistant/tool_result，
		// 事件类型本身不会出现在 messages JSON 里
		expect(JSON.stringify(deriveMessages(events, "worker-1"))).not.toContain(
			"todo/set",
		);

		// tool_result 回渲染清单文本（下一步模型历史据此自检进度）
		const todoResult = events.find(
			(e) => e.type === "tool_result" && e.toolCallId === "w-tc-1",
		);
		expect(todoResult).toMatchObject({
			type: "tool_result",
			agentId: "worker-1",
			isError: false,
		});
		if (todoResult?.type !== "tool_result") throw new Error("unreachable");
		expect(todoResult.content).toBe(
			"- [completed] read config\n- [in_progress] patch loader\n- [pending] add tests",
		);

		// 第一步请求的 prompt 尚无清单（fold 时日志里还没有 todo/set）
		expect(requests[0]?.system).not.toContain("Task list");
	});

	it("会话恢复后同一 worker 的 prompt 折入上次清单；其他 agent 的 prompt 不含", async () => {
		// 第一轮：worker-1 调 todo 落盘（两轮的调用序各自独立，recording 均新建）
		const firstRequests: ChatRequest[] = [];
		const firstAdapter = recordingAdapter(
			[
				toolCallRound("todo", "w-tc-1", TODO_INPUT),
				textRound("清单已更新。", { input: 50, output: 10 }),
			],
			firstRequests,
		);
		const firstRuntime = await makeRuntime(firstAdapter);
		await runAgentInline(
			firstRuntime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);

		// 第二轮：模拟 CLI --session 恢复（resumeSession + 新 runtime），
		// 同一 worker 再跑一轮，system prompt 必须折入上次清单
		const resumedRequests: ChatRequest[] = [];
		const resumedAdapter = recordingAdapter(
			[textRound("继续干活。", { input: 60, output: 12 })],
			resumedRequests,
		);
		const resumedRuntime = await makeRuntime(
			resumedAdapter,
			firstRuntime.session.filePath,
		);
		await runAgentInline(
			resumedRuntime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		const resumedSystem = resumedRequests[0]?.system ?? "";
		expect(resumedSystem).toContain("Task list");
		expect(resumedSystem).toContain("- [completed] read config");
		expect(resumedSystem).toContain("- [in_progress] patch loader");
		expect(resumedSystem).toContain("- [pending] add tests");

		// 同一恢复会话里，没写过清单的 worker-2 的 prompt 不含该段（fold 按 agentId 隔离）
		const otherRequests: ChatRequest[] = [];
		const otherAdapter = recordingAdapter(
			[textRound("别的 worker。", { input: 60, output: 12 })],
			otherRequests,
		);
		const otherRuntime = await makeRuntime(
			otherAdapter,
			firstRuntime.session.filePath,
		);
		await runAgentInline(
			otherRuntime,
			"worker-2",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(otherRequests[0]?.system).not.toContain("Task list");
	});

	it("features.todo=false：注册表无 todo 工具，prompt 也不出 task-list 段", async () => {
		// 先造一份带 todo/set 历史的会话
		const seedRequests: ChatRequest[] = [];
		const seedAdapter = recordingAdapter(
			[
				toolCallRound("todo", "w-tc-1", TODO_INPUT),
				textRound("清单已更新。", { input: 50, output: 10 }),
			],
			seedRequests,
		);
		const seedRuntime = await makeRuntime(seedAdapter);
		await runAgentInline(
			seedRuntime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);

		// 关闭开关后恢复会话再跑：注册表无 todo，prompt 无清单段
		const offRequests: ChatRequest[] = [];
		const offAdapter = recordingAdapter(
			[textRound("收到。", { input: 60, output: 12 })],
			offRequests,
		);
		const offRuntime = await makeRuntime(
			offAdapter,
			seedRuntime.session.filePath,
			{ todo: false },
		);
		const registry = createWorkerRegistry(offRuntime, {
			agentId: "worker-1",
			tier: "low",
		});
		expect(
			registry
				.declarations()
				.map((d) => d.name)
				.sort(),
		).toEqual(["bash", "edit", "read", "spawn_tasks", "write"]);

		await runAgentInline(
			offRuntime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(offRequests[0]?.system).not.toContain("Task list");
	});
});
