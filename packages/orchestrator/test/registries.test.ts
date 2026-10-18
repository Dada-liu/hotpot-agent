// 角色注册表与角色系统提示词测试：
// - 按角色断言 registry 内工具名集合精确相等（main=仅元工具；worker=四件套+spawn_tasks；task=仅四件套）
// - 断言 buildRoleSystemPrompt 含关键指令短语（main 难度判定、worker 并行拆分、task 原子任务），
//   且同进程连续构建三种角色 prompt 互不污染（core 的 section 注册表是全局单例，不得泄漏）
// - M4 矩阵：role × features × runtime 透传字段（mcpTools）的注册表内容；
//   decorateWorkerTool 只包四件套、feature 外工具裸注册
import type { ToolDeclaration } from "@hotpot/ai";
import {
	ApprovalChain,
	type ToolDefinition,
	type ToolRegistry,
} from "@hotpot/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRoleSystemPrompt } from "../src/prompts.ts";
import { createRoleRegistry } from "../src/registries.ts";
import type { OrchestrationRuntime } from "../src/runtime.ts";

// 元工具桩：Task 7 才提供真实 delegate/spawn_workers/spawn_tasks，这里只钉名字集合
function stubMetaTool(name: string): ToolDefinition<unknown> {
	return {
		name,
		description: `stub meta tool ${name}`,
		parameters: z.object({}),
		execute: async () => ({ content: "ok" }),
	};
}

const MAIN_META = [stubMetaTool("delegate"), stubMetaTool("spawn_workers")];
const WORKER_META = [stubMetaTool("spawn_tasks")];

// 最小 runtime 桩：注册表只消费 decorateWorkerTool/features/mcpTools，其余字段原样占位
function stubRuntime(
	overrides?: Partial<
		Pick<OrchestrationRuntime, "decorateWorkerTool" | "features" | "mcpTools">
	>,
): OrchestrationRuntime {
	return {
		session: {
			id: "test-session",
			filePath: "/tmp/test-session.jsonl",
			append: async () => {},
		},
		cwd: "/tmp/project",
		approval: new ApprovalChain(),
		maxParallelTasks: 10,
		planMaxRevisions: 3,
		resolveModel: () => {
			throw new Error("stubRuntime: resolveModel not implemented");
		},
		spawn: async () => ({ agentId: "worker-1" }),
		...overrides,
	};
}

function names(registry: ToolRegistry): string[] {
	return registry
		.declarations()
		.map((d) => d.name)
		.sort();
}

function makeCtx(tools: ToolDeclaration[]) {
	return {
		cwd: "/Users/test/project",
		os: "darwin",
		date: "2026-10-15",
		tools,
	};
}

describe("createRoleRegistry 按角色装配工具集", () => {
	it("main = 仅元工具，无文件四件套", () => {
		const registry = createRoleRegistry(stubRuntime(), "main", MAIN_META);
		expect(names(registry)).toEqual(["delegate", "spawn_workers"]);
	});

	it("worker = bash/read/write/edit + todo + spawn_tasks", () => {
		const registry = createRoleRegistry(stubRuntime(), "worker", WORKER_META);
		expect(names(registry)).toEqual([
			"bash",
			"edit",
			"read",
			"spawn_tasks",
			"todo",
			"write",
		]);
	});

	it("task = 仅 bash/read/write/edit + todo，忽略 metaTools", () => {
		const registry = createRoleRegistry(stubRuntime(), "task", WORKER_META);
		expect(names(registry)).toEqual(["bash", "edit", "read", "todo", "write"]);
	});
});

describe("buildRoleSystemPrompt 角色指令", () => {
	it("三角色 prompt 都含 core 基础段（identity/tools/rules/env）", () => {
		for (const role of ["main", "worker", "task"] as const) {
			const prompt = buildRoleSystemPrompt(role, makeCtx([]));
			expect(prompt).toContain("hotpot-code");
			expect(prompt).toContain("Tool use rules");
			expect(prompt).toContain("Working directory: /Users/test/project");
			expect(prompt).toContain("2026-10-15");
		}
	});

	it("main 提示词含难度判定规则：trivial 直答、complex 先 plan、边界示例", () => {
		const registry = createRoleRegistry(stubRuntime(), "main", MAIN_META);
		const prompt = buildRoleSystemPrompt(
			"main",
			makeCtx(registry.declarations()),
		);

		expect(prompt).toContain("difficulty");
		expect(prompt).toContain("trivial");
		expect(prompt).toContain("simple");
		expect(prompt).toContain("complex");
		// §2 边界示例：≤3 文件 → simple；拿不准 → complex
		expect(prompt).toContain("at most 3 files");
		expect(prompt).toContain("When in doubt");
		// trivial 直接答、complex 先给 plan 等用户批准
		expect(prompt).toMatch(/[Aa]nswer directly/);
		expect(prompt).toMatch(/approval before/);
		// main 不操作文件：工具清单来自 ctx.tools（delegate/spawn_workers），不列文件四件套
		expect(prompt).toContain("delegate");
		expect(prompt).not.toContain("- bash:");
		expect(prompt).not.toContain("- read:");
	});

	it("worker 提示词含并行拆分三条件与正反例、spawn_tasks 与结构化摘要要求", () => {
		const registry = createRoleRegistry(stubRuntime(), "worker", WORKER_META);
		const prompt = buildRoleSystemPrompt(
			"worker",
			makeCtx(registry.declarations()),
		);

		expect(prompt).toContain("spawn_tasks");
		expect(prompt).toMatch(/parallel/i);
		// §4 正例：8 个只读审查任务可并行；反例：写函数+写测试因签名依赖须串行
		expect(prompt).toContain("8 files");
		expect(prompt).toContain("signature");
		// §5 摘要回传四要素
		expect(prompt).toContain("what was done");
		expect(prompt).toContain("key file paths");
		expect(prompt).toContain("problems encountered");
		expect(prompt).toContain("verification results");
	});

	it("task 提示词强调原子任务、无派生能力、输出结果摘要", () => {
		const registry = createRoleRegistry(stubRuntime(), "task", WORKER_META);
		const prompt = buildRoleSystemPrompt(
			"task",
			makeCtx(registry.declarations()),
		);

		expect(prompt).toMatch(/atomic/);
		expect(prompt).toContain("what was done");
		// task 无派生能力：指令里不出现 spawn_tasks
		expect(prompt).not.toContain("spawn_tasks");
	});

	it("同进程连续构建三角色 prompt 互不污染（不依赖全局 section 注册表）", () => {
		const mainPrompt = buildRoleSystemPrompt("main", makeCtx([]));
		const workerPrompt = buildRoleSystemPrompt("worker", makeCtx([]));
		const taskPrompt = buildRoleSystemPrompt("task", makeCtx([]));

		expect(mainPrompt).toContain("difficulty");
		expect(mainPrompt).not.toContain("spawn_tasks");
		expect(mainPrompt).not.toContain("8 files");
		expect(workerPrompt).toContain("spawn_tasks");
		expect(taskPrompt).not.toContain("spawn_tasks");
	});
});

// M4 矩阵：role × features × runtime 透传字段。feature 派生外工具现有 todo（Task 2）
// 与 mcpTools（Task 5 样板），矩阵钉死规则：
// - 外工具只进 worker/task，main 永远只有元工具
// - 开关缺省（undefined）= 开（featureEnabled `?? true`）；显式 false 才不注册
// - decorateWorkerTool 只包四件套，外工具与元工具均不装饰
describe("createRoleRegistry role×feature 矩阵", () => {
	const mcpTool = stubMetaTool("mcp__demo__tool");
	const BASE_FOUR = ["bash", "edit", "read", "write"];
	const WORKER_WITH_TODO = [
		"bash",
		"edit",
		"read",
		"spawn_tasks",
		"todo",
		"write",
	];

	it("worker + features 缺省 + mcpTools 提供 → 并入外工具（缺省全开）", () => {
		const registry = createRoleRegistry(
			stubRuntime({ mcpTools: [mcpTool] }),
			"worker",
			WORKER_META,
		);
		expect(names(registry)).toEqual([
			"bash",
			"edit",
			"mcp__demo__tool",
			"read",
			"spawn_tasks",
			"todo",
			"write",
		]);
	});

	it("worker + features.mcp=false → 不注册 mcp 外工具，todo 缺省仍注册", () => {
		const registry = createRoleRegistry(
			stubRuntime({ features: { mcp: false }, mcpTools: [mcpTool] }),
			"worker",
			WORKER_META,
		);
		expect(names(registry)).toEqual(WORKER_WITH_TODO);
	});

	it("worker + features.todo=false → 不注册 todo，mcp 缺省仍注册", () => {
		const registry = createRoleRegistry(
			stubRuntime({ features: { todo: false }, mcpTools: [mcpTool] }),
			"worker",
			WORKER_META,
		);
		expect(names(registry)).toEqual([
			"bash",
			"edit",
			"mcp__demo__tool",
			"read",
			"spawn_tasks",
			"write",
		]);
	});

	it("worker + features 全开但外工具数据缺省（mcpTools 缺省）→ 空透传不报错、只加 todo", () => {
		const registry = createRoleRegistry(
			stubRuntime({
				features: {
					todo: true,
					hooks: true,
					skills: true,
					promptTemplates: true,
					webSearch: true,
					webFetch: true,
					mcp: true,
				},
			}),
			"worker",
			WORKER_META,
		);
		expect(names(registry)).toEqual(WORKER_WITH_TODO);
	});

	it("task + features 全开 + mcpTools 提供 → task 同样并入外工具", () => {
		const registry = createRoleRegistry(
			stubRuntime({
				features: {
					todo: true,
					hooks: true,
					skills: true,
					promptTemplates: true,
					webSearch: true,
					webFetch: true,
					mcp: true,
				},
				mcpTools: [mcpTool],
			}),
			"task",
			WORKER_META,
		);
		expect(names(registry)).toEqual([
			"bash",
			"edit",
			"mcp__demo__tool",
			"read",
			"todo",
			"write",
		]);
	});

	it("task + features.todo=false → task 也无 todo", () => {
		const registry = createRoleRegistry(
			stubRuntime({ features: { todo: false } }),
			"task",
			WORKER_META,
		);
		expect(names(registry)).toEqual(BASE_FOUR);
	});

	it("main + features 全开 + mcpTools 提供 → 仍只有元工具（外工具不进 main）", () => {
		const registry = createRoleRegistry(
			stubRuntime({
				features: {
					todo: true,
					hooks: true,
					skills: true,
					promptTemplates: true,
					webSearch: true,
					webFetch: true,
					mcp: true,
				},
				mcpTools: [mcpTool],
			}),
			"main",
			MAIN_META,
		);
		expect(names(registry)).toEqual(["delegate", "spawn_workers"]);
	});

	it("main + features 缺省 → 同样只有元工具（todo 缺省全开也不进 main）", () => {
		const registry = createRoleRegistry(stubRuntime(), "main", MAIN_META);
		expect(names(registry)).toEqual(["delegate", "spawn_workers"]);
	});

	it("decorateWorkerTool 只包四件套：外工具与元工具保持原样", () => {
		const decorated: string[] = [];
		const decorate = (tool: ToolDefinition<unknown>) => {
			decorated.push(tool.name);
			return tool;
		};
		const registry = createRoleRegistry(
			stubRuntime({ decorateWorkerTool: decorate, mcpTools: [mcpTool] }),
			"worker",
			WORKER_META,
		);
		// 装饰器只被应用到四件套（todo 与 mcp 外工具、spawn_tasks 均不装饰）
		expect(decorated.sort()).toEqual(BASE_FOUR);
		expect(names(registry)).toEqual([
			"bash",
			"edit",
			"mcp__demo__tool",
			"read",
			"spawn_tasks",
			"todo",
			"write",
		]);
	});
});

// M4：buildRoleSystemPrompt 可选 opts（skills/todos 动态段）——缺省行为不变、空列表不出段
describe("buildRoleSystemPrompt M4 动态段", () => {
	it("不传 opts 与传空列表都不出 skills/todos 段（默认行为与 M2 一致）", () => {
		const bare = buildRoleSystemPrompt("worker", makeCtx([]));
		const empty = buildRoleSystemPrompt("worker", makeCtx([]), {
			skills: [],
			todos: [],
		});
		expect(bare).not.toContain("Available skills");
		expect(bare).not.toContain("Task list");
		expect(empty).not.toContain("Available skills");
		expect(empty).not.toContain("Task list");
	});

	it("skills 非空出段：清单含 name/description/path 与加载指令，位于角色指令之前", () => {
		const prompt = buildRoleSystemPrompt("worker", makeCtx([]), {
			skills: [
				{
					name: "commit",
					description: "Write conventional commits",
					path: "/home/u/.hotpot/skills/commit/SKILL.md",
				},
			],
		});
		expect(prompt).toContain("Available skills");
		expect(prompt).toContain(
			"- commit — Write conventional commits (/home/u/.hotpot/skills/commit/SKILL.md)",
		);
		expect(prompt).toContain("read its file first");
	});

	it("todos 非空出段：全量清单带状态，供模型自检进度", () => {
		const prompt = buildRoleSystemPrompt("task", makeCtx([]), {
			todos: [
				{ content: "read config", status: "completed" },
				{ content: "patch loader", status: "in_progress" },
			],
		});
		expect(prompt).toContain("Task list");
		expect(prompt).toContain("- [completed] read config");
		expect(prompt).toContain("- [in_progress] patch loader");
	});
});
