// 角色注册表与角色系统提示词测试：
// - 按角色断言 registry 内工具名集合精确相等（main=仅元工具；worker=四件套+spawn_tasks；task=仅四件套）
// - 断言 buildRoleSystemPrompt 含关键指令短语（main 难度判定、worker 并行拆分、task 原子任务），
//   且同进程连续构建三种角色 prompt 互不污染（core 的 section 注册表是全局单例，不得泄漏）
import type { ToolDeclaration } from "@hotpot/ai";
import type { ToolDefinition, ToolRegistry } from "@hotpot/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRoleSystemPrompt } from "../src/prompts.ts";
import { createRoleRegistry } from "../src/registries.ts";

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
		const registry = createRoleRegistry("main", MAIN_META);
		expect(names(registry)).toEqual(["delegate", "spawn_workers"]);
	});

	it("worker = bash/read/write/edit + spawn_tasks", () => {
		const registry = createRoleRegistry("worker", WORKER_META);
		expect(names(registry)).toEqual([
			"bash",
			"edit",
			"read",
			"spawn_tasks",
			"write",
		]);
	});

	it("task = 仅 bash/read/write/edit，忽略 metaTools", () => {
		const registry = createRoleRegistry("task", WORKER_META);
		expect(names(registry)).toEqual(["bash", "edit", "read", "write"]);
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
		const registry = createRoleRegistry("main", MAIN_META);
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
		const registry = createRoleRegistry("worker", WORKER_META);
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
		const registry = createRoleRegistry("task", WORKER_META);
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
