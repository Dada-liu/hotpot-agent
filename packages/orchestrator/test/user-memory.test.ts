// 用户记忆编排接入：按角色注册写工具，并在每次构建系统提示词时读取最新 Markdown 摘要
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatRequest,
	type LlmAdapter,
	type StreamEvent,
	scriptedAdapter,
} from "@hotpot/ai";
import {
	ApprovalChain,
	appendMemory,
	createSession,
	featureEnabled,
	loadSession,
	type ModelTier,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMainTurn } from "../src/main-turn/main-turn.ts";
import { buildRoleSystemPrompt } from "../src/prompts/prompts.ts";
import { createRoleRegistry } from "../src/registries/registries.ts";
import {
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";
import { runAgentInline } from "../src/tools/run-worker.ts";
import type { AgentRole } from "../src/types/types.ts";

let home: string;
let cwd: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-orchestrator-memory-home-"));
	cwd = await mkdtemp(join(tmpdir(), "hotpot-orchestrator-memory-cwd-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

function textRound(text: string): StreamEvent[] {
	return [
		{ type: "text_delta", delta: text },
		{ type: "usage", usage: { input: 10, output: 5 } },
		{ type: "finish", reason: "stop" },
	];
}

function memorySaveRound(content: string): StreamEvent[] {
	return [
		{ type: "tool_call_start", id: "memory-call-1", name: "memory_save" },
		{
			type: "tool_call_delta",
			id: "memory-call-1",
			inputDelta: JSON.stringify({ content }),
		},
		{ type: "tool_call_end", id: "memory-call-1" },
		{ type: "usage", usage: { input: 10, output: 5 } },
		{ type: "finish", reason: "tool_calls" },
	];
}

async function makeRuntime(
	script: StreamEvent[][],
	features: Settings["features"],
): Promise<{ runtime: OrchestrationRuntime; requests: ChatRequest[] }> {
	const session = await createSession(cwd, home);
	const requests: ChatRequest[] = [];
	const inner = scriptedAdapter(script);
	const adapter: LlmAdapter = {
		api: inner.api,
		streamChat(request, signal) {
			requests.push(request);
			return inner.streamChat(request, signal);
		},
	};
	const base = createRuntime({
		session,
		cwd,
		home,
		approval: new ApprovalChain(),
		models: MODELS,
		features,
	});
	return {
		requests,
		runtime: {
			...base,
			resolveModel(tier: ModelTier) {
				return { ...base.resolveModel(tier), adapter };
			},
		},
	};
}

async function runMain(runtime: OrchestrationRuntime, message: string) {
	for await (const event of runMainTurn({
		runtime,
		userMessage: message,
		signal: new AbortController().signal,
		mainTier: "high",
	})) {
		if (event.type === "error") {
			throw new Error(event.error.message);
		}
	}
}

describe("orchestrator user memory", () => {
	it("memory 开关只为 main/worker 注册 memory_save，task 永远不写记忆", async () => {
		const session = await createSession(cwd, home);
		const enabled = createRuntime({
			session,
			cwd,
			home,
			approval: new ApprovalChain(),
			models: MODELS,
			features: { memory: true },
		});
		for (const role of ["main", "worker"] as const) {
			expect(
				createRoleRegistry(enabled, role, [])
					.declarations()
					.map((tool) => tool.name),
			).toContain("memory_save");
		}
		expect(
			createRoleRegistry(enabled, "task", [])
				.declarations()
				.map((tool) => tool.name),
		).not.toContain("memory_save");

		const disabled = createRuntime({
			session,
			cwd,
			home,
			approval: new ApprovalChain(),
			models: MODELS,
			features: { memory: false },
		});
		for (const role of ["main", "worker", "task"] as const) {
			expect(
				createRoleRegistry(disabled, role, [])
					.declarations()
					.map((tool) => tool.name),
			).not.toContain("memory_save");
		}
	});

	it("三个角色只注入非空 memory section，并包含稳定事实与隐私边界", () => {
		const ctx = {
			cwd,
			os: "test-os",
			date: "2026-11-11",
			tools: [],
		};
		for (const role of ["main", "worker", "task"] satisfies AgentRole[]) {
			const prompt = buildRoleSystemPrompt(role, ctx, {
				memory: "- The user prefers concise answers.",
			});
			expect(prompt).toContain("User memory");
			expect(prompt).toContain("The user prefers concise answers.");
			expect(prompt).toContain("stable user preferences and facts");
			expect(prompt).toContain("Do not save secrets");
			expect(prompt).toContain("temporary task state");
			expect(buildRoleSystemPrompt(role, ctx, { memory: "" })).not.toContain(
				"User memory",
			);
		}
	});

	it("main 每轮读取最新记忆，memory_save 写盘且审计事件不含正文", async () => {
		await writeFile(
			join(home, "MEMORY.md"),
			"# User Memory\n- Existing preference.\n",
			"utf8",
		);
		const { runtime, requests } = await makeRuntime(
			[
				memorySaveRound("The user prefers pnpm."),
				textRound("Saved."),
				textRound("Second turn."),
			],
			{ memory: true },
		);

		await runMain(runtime, "Remember my package manager");
		expect(requests[0]?.system).toContain("Existing preference.");
		expect(requests[0]?.tools.map((tool) => tool.name)).toContain(
			"memory_save",
		);
		expect(await readFile(join(home, "MEMORY.md"), "utf8")).toContain(
			"- The user prefers pnpm.",
		);
		const { events } = await loadSession(runtime.session.filePath);
		const saved = events.find((event) => event.type === "memory/saved");
		expect(saved).toMatchObject({ type: "memory/saved", agentId: "main" });
		expect(saved).not.toHaveProperty("content");

		await appendMemory("The user uses pnpm workspaces.", home);
		await runMain(runtime, "Start another turn");
		expect(requests[2]?.system).toContain("The user prefers pnpm.");
		expect(requests[2]?.system).toContain("The user uses pnpm workspaces.");
	});

	it("planning/revision 的真实请求读取记忆，修订前写入的内容立即可见", async () => {
		await writeFile(
			join(home, "MEMORY.md"),
			"# User Memory\n- Initial planning preference.\n",
			"utf8",
		);
		const firstPlan = `# Plan\n\n## Steps\n1. First draft\n\n## Files\na.ts\n\n## Acceptance criteria\nFirst draft passes`;
		const revisedPlan = `# Plan\n\n## Steps\n1. Revised draft\n\n## Files\na.ts\n\n## Acceptance criteria\nRevised draft passes`;
		const { runtime, requests } = await makeRuntime(
			[textRound(firstPlan), textRound(revisedPlan), textRound("Executed.")],
			{ memory: true },
		);
		const decisions: Array<"annotate" | "approve"> = ["annotate", "approve"];
		for await (const event of runMainTurn({
			runtime,
			userMessage: "Plan a change",
			signal: new AbortController().signal,
			mainTier: "high",
			onPlanApproval: async () => {
				const decision = decisions.shift();
				if (decision === "annotate") {
					await appendMemory("Added immediately before revision.", home);
					return { kind: "annotate", note: "Revise with latest memory" };
				}
				if (decision === "approve") return { kind: "approve" };
				throw new Error("unexpected plan approval");
			},
		})) {
			if (event.type === "error") throw new Error(event.error.message);
		}

		expect(requests).toHaveLength(3);
		expect(requests[0]?.system).toContain("Initial planning preference.");
		expect(requests[0]?.system).not.toContain(
			"Added immediately before revision.",
		);
		expect(requests[1]?.tools).toEqual([]);
		expect(requests[1]?.system).toContain("Initial planning preference.");
		expect(requests[1]?.system).toContain("Added immediately before revision.");
		expect(requests[2]?.system).toContain("Added immediately before revision.");
	});

	it("whitespace-only MEMORY.md 不在真实请求中产生空 memory section", async () => {
		await writeFile(join(home, "MEMORY.md"), " \n\t\n", "utf8");
		const { runtime, requests } = await makeRuntime([textRound("No memory.")], {
			memory: true,
		});

		await runMain(runtime, "Answer without a memory section");
		expect(requests[0]?.system).not.toContain("User memory");
	});

	it("memory 关闭时真实 ChatRequest 不含记忆正文或工具", async () => {
		await writeFile(
			join(home, "MEMORY.md"),
			"# User Memory\n- Disabled memory sentinel.\n",
			"utf8",
		);
		const { runtime, requests } = await makeRuntime(
			[textRound("Plain answer.")],
			{
				memory: false,
			},
		);

		await runMain(runtime, "Answer without memory");
		expect(featureEnabled(runtime.features, "memory")).toBe(false);
		expect(requests[0]?.system).not.toContain("Disabled memory sentinel.");
		expect(requests[0]?.system).not.toContain("User memory");
		expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain(
			"memory_save",
		);
	});

	it("worker/task 的首次真实请求读取记忆，但只有 worker 收到写工具", async () => {
		await writeFile(
			join(home, "MEMORY.md"),
			"# User Memory\n- The user prefers strict TypeScript.\n",
			"utf8",
		);
		const { runtime, requests } = await makeRuntime(
			[textRound("Worker done."), textRound("Task done.")],
			{ memory: true },
		);

		await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		await runAgentInline(
			runtime,
			"task-1",
			"task",
			"low",
			new AbortController().signal,
		);

		expect(requests[0]?.system).toContain(
			"The user prefers strict TypeScript.",
		);
		expect(requests[0]?.tools.map((tool) => tool.name)).toContain(
			"memory_save",
		);
		expect(requests[1]?.system).toContain(
			"The user prefers strict TypeScript.",
		);
		expect(requests[1]?.tools.map((tool) => tool.name)).not.toContain(
			"memory_save",
		);
	});
});
