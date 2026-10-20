// Feature④ skill 支持测试（prompt 段 + read 追踪 + 端到端落盘）：
// - buildRoleSystemPrompt 三角色（main/worker/task）都注入 skills 段（name — description (path)）
// - worker/task 注册表的 read 包追踪：命中已知 SKILL.md 路径 append skill/loaded，
//   每会话每文件只记一次（相对路径经 ctx.cwd 解析后匹配）；isError 读不记；普通文件不记
// - features.skills=false：注册表不追踪（runAgentInline 的 prompt 也不出段，双无）
// - runAgentInline 端到端（scriptedAdapter 回放）：worker read skill 文件 →
//   会话日志落一条 skill/loaded（agentId/skill/path 齐全），system prompt 含清单段
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	loadSession,
	type ModelTier,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRoleSystemPrompt } from "../src/prompts/prompts.ts";
import {
	createRoleRegistry,
	createWorkerRegistry,
} from "../src/registries/registries.ts";
import {
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";
import { runAgentInline } from "../src/tools/run-worker.ts";

let home: string;
let proj: string;
let skillDir: string;
let skillPath: string;

const SKILL_MD =
	"---\nname: commit\ndescription: Write conventional commits\n---\n# commit\n";

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-skill-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-skill-proj-"));
	// skill 放在项目 .hotpot/skills 下（与装配层扫描位置一致），路径在 proj 内，
	// 测试用相对路径 read 时经 ctx.cwd 解析
	skillDir = join(proj, ".hotpot", "skills", "commit");
	await mkdir(skillDir, { recursive: true });
	skillPath = join(skillDir, "SKILL.md");
	await writeFile(skillPath, SKILL_MD);
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

// skillPath 由 beforeEach 生成，清单必须在用例内现取（模块级常量会捕获 undefined）
function skillList(): {
	name: string;
	description: string;
	path: string;
}[] {
	return [
		{
			name: "commit",
			description: "Write conventional commits",
			path: skillPath,
		},
	];
}

// 最小 ctx：read 只消费 cwd/agentId/session；signal 用未触发的 AbortController
function makeToolCtx(runtime: OrchestrationRuntime, agentId = "worker-1") {
	return {
		cwd: runtime.cwd,
		signal: new AbortController().signal,
		approval: new ApprovalChain(),
		agentId,
		session: runtime.session,
	};
}

async function makeRuntime(
	features?: Settings["features"],
): Promise<OrchestrationRuntime> {
	const session = await createSession(proj, home);
	return createRuntime({
		session,
		cwd: proj,
		approval: new ApprovalChain(),
		models: MODELS,
		features,
	});
}

// 便捷：建带 skills 的 runtime（开关默认全开）
async function makeSkilledRuntime(
	features?: Settings["features"],
): Promise<OrchestrationRuntime> {
	const runtime = await makeRuntime(features);
	return { ...runtime, skills: skillList() };
}

function skillLoadedEvents(
	events: SessionEvent[],
): Extract<SessionEvent, { type: "skill/loaded" }>[] {
	return events.filter(
		(e): e is Extract<SessionEvent, { type: "skill/loaded" }> =>
			e.type === "skill/loaded",
	);
}

describe("buildRoleSystemPrompt skills 段（三角色注入）", () => {
	const ctx = { cwd: "/p", os: "darwin", date: "2026-10-18", tools: [] };

	it("main/worker/task 的 prompt 都含 name — description (path) 清单行与加载指令", () => {
		for (const role of ["main", "worker", "task"] as const) {
			const prompt = buildRoleSystemPrompt(role, ctx, { skills: skillList() });
			expect(prompt).toContain("Available skills");
			expect(prompt).toContain(
				`- commit — Write conventional commits (${skillPath})`,
			);
			expect(prompt).toContain("read its file first");
		}
	});

	it("skills 默认/为空不出段（默认行为不变）", () => {
		expect(buildRoleSystemPrompt("worker", ctx)).not.toContain(
			"Available skills",
		);
		expect(buildRoleSystemPrompt("worker", ctx, { skills: [] })).not.toContain(
			"Available skills",
		);
	});
});

describe("read 工具的 skill 追踪包装", () => {
	it("read 命中已知 SKILL.md（相对路径）→ 落盘 skill/loaded，每文件每会话只记一次", async () => {
		const runtime = await makeSkilledRuntime();
		const registry = createRoleRegistry(runtime, "worker", []);
		const read = registry.get("read");
		expect(read).toBeDefined();

		const ctx = makeToolCtx(runtime);
		const first = await read?.execute(
			{ path: ".hotpot/skills/commit/SKILL.md" },
			ctx,
		);
		expect(first?.isError).not.toBe(true);
		const second = await read?.execute(
			{ path: ".hotpot/skills/commit/SKILL.md" },
			ctx,
		);
		expect(second?.isError).not.toBe(true);

		const { events } = await loadSession(runtime.session.filePath);
		const loaded = skillLoadedEvents(events);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toMatchObject({
			agentId: "worker-1",
			skill: "commit",
			path: skillPath,
		});
	});

	it("read 其他 skill 文件与不同 agent 各自记事件", async () => {
		const otherDir = join(proj, ".hotpot", "skills", "review");
		await mkdir(otherDir, { recursive: true });
		await writeFile(
			join(otherDir, "SKILL.md"),
			"---\nname: review\ndescription: Review code\n---\n# review\n",
		);
		const runtime = await makeSkilledRuntime();
		const registry = createRoleRegistry(runtime, "task", []);
		const read = registry.get("read");
		const skills = [
			...skillList(),
			{
				name: "review",
				description: "Review code",
				path: join(otherDir, "SKILL.md"),
			},
		];
		const tracked = createRoleRegistry({ ...runtime, skills }, "task", []).get(
			"read",
		);

		const ctx = makeToolCtx(runtime, "task-1");
		await read?.execute({ path: skillPath }, ctx);
		await tracked?.execute({ path: join(otherDir, "SKILL.md") }, ctx);

		const { events } = await loadSession(runtime.session.filePath);
		const loaded = skillLoadedEvents(events);
		expect(loaded).toHaveLength(2);
		expect(loaded.map((e) => `${e.agentId}:${e.skill}`).sort()).toEqual([
			"task-1:commit",
			"task-1:review",
		]);
	});

	it("read 非 skill 文件不记事件", async () => {
		await writeFile(join(proj, "note.txt"), "hello\n");
		const runtime = await makeSkilledRuntime();
		const registry = createRoleRegistry(runtime, "worker", []);
		const out = await registry
			.get("read")
			?.execute({ path: "note.txt" }, makeToolCtx(runtime));
		expect(out?.isError).not.toBe(true);
		const { events } = await loadSession(runtime.session.filePath);
		expect(skillLoadedEvents(events)).toHaveLength(0);
	});

	it("read 失败（isError）不算加载，不记事件", async () => {
		const runtime = await makeSkilledRuntime();
		const registry = createRoleRegistry(runtime, "worker", []);
		const out = await registry.get("read")?.execute(
			{ path: ".hotpot/skills/commit/SKILL.md" },
			{
				...makeToolCtx(runtime),
				cwd: join(proj, "elsewhere"),
			},
		);
		// cwd 换到别处后相对路径解析不到文件：read 本身 isError，追踪跳过
		expect(out?.isError).toBe(true);
		const { events } = await loadSession(runtime.session.filePath);
		expect(skillLoadedEvents(events)).toHaveLength(0);
	});

	it("features.skills=false：不追踪（注册表第二道门）", async () => {
		const runtime = await makeSkilledRuntime({ skills: false });
		const registry = createRoleRegistry(runtime, "worker", []);
		await registry
			.get("read")
			?.execute({ path: skillPath }, makeToolCtx(runtime));
		const { events } = await loadSession(runtime.session.filePath);
		expect(skillLoadedEvents(events)).toHaveLength(0);
	});

	it("runtime.skills 默认不追踪（外工具数据默认不报错）", async () => {
		const runtime = await makeRuntime();
		const registry = createRoleRegistry(runtime, "worker", []);
		const out = await registry
			.get("read")
			?.execute({ path: skillPath }, makeToolCtx(runtime));
		expect(out?.isError).not.toBe(true);
	});
});

// —— 端到端：scriptedAdapter 回放，验证「prompt 段 + 追踪落盘」接线 ——

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

function withAdapter(
	runtime: OrchestrationRuntime,
	adapter: LlmAdapter,
): OrchestrationRuntime {
	return {
		...runtime,
		resolveModel(tier: ModelTier) {
			return { ...runtime.resolveModel(tier), adapter };
		},
	};
}

describe("skill 端到端（runAgentInline）", () => {
	it("worker 经 read 加载 skill：prompt 含清单段，会话落盘 skill/loaded", async () => {
		const requests: ChatRequest[] = [];
		const adapter = recordingAdapter(
			[
				toolCallRound(
					"read",
					"w-tc-1",
					'{"path":".hotpot/skills/commit/SKILL.md"}',
				),
				textRound("已加载 skill。", { input: 50, output: 10 }),
			],
			requests,
		);
		const base = await makeSkilledRuntime();
		const runtime = withAdapter(base, adapter);

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(outcome.failures).toEqual([]);
		expect(outcome.summary).toBe("已加载 skill。");

		// prompt 段：清单行 + 渐进式加载指令
		expect(requests[0]?.system).toContain("Available skills");
		expect(requests[0]?.system).toContain(
			`- commit — Write conventional commits (${skillPath})`,
		);

		// 追踪落盘：skill/loaded 带 agentId/skill/path
		const { events } = await loadSession(runtime.session.filePath);
		const loaded = skillLoadedEvents(events);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toMatchObject({
			agentId: "worker-1",
			skill: "commit",
			path: skillPath,
		});

		// worker 注册表里 read 与其他工具共存，追踪不改变声明面
		const registry = createWorkerRegistry(runtime, {
			agentId: "worker-1",
			tier: "low",
		});
		const names = registry
			.declarations()
			.map((d) => d.name)
			.sort();
		expect(names).toContain("read");
		expect(names).toContain("spawn_tasks");
	});

	it("features.skills=false：prompt 无 skills 段、read 不追踪（双无）", async () => {
		const requests: ChatRequest[] = [];
		const adapter = recordingAdapter(
			[
				toolCallRound(
					"read",
					"w-tc-1",
					'{"path":".hotpot/skills/commit/SKILL.md"}',
				),
				textRound("收到。", { input: 50, output: 10 }),
			],
			requests,
		);
		// 装配层关闭开关时不扫描、不传 skills；这里 runtime 强行带上 skills，
		// 验证 orchestrator 层的第二道门：不出段、不追踪
		const base = await makeSkilledRuntime({ skills: false });
		const runtime = withAdapter(base, adapter);

		const outcome = await runAgentInline(
			runtime,
			"worker-1",
			"worker",
			"low",
			new AbortController().signal,
		);
		expect(outcome.failures).toEqual([]);

		expect(requests[0]?.system).not.toContain("Available skills");
		const { events } = await loadSession(runtime.session.filePath);
		expect(skillLoadedEvents(events)).toHaveLength(0);
	});
});
