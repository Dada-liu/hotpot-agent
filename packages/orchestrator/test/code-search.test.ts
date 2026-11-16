import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApprovalChain,
	createSession,
	loadSession,
	type SessionEvent,
	type Settings,
	type ToolContext,
} from "@hotpot/core";
import {
	type CodeIndexService,
	type CodeSearchResult,
	createCodeIndexService,
	createCodeSearchTool,
} from "@hotpot/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRoleSystemPrompt } from "../src/prompts/prompts.ts";
import { createRoleRegistry } from "../src/registries/registries.ts";
import type { OrchestrationRuntime } from "../src/runtime/runtime.ts";

let root: string;
let cwd: string;
let home: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hotpot-code-search-test-"));
	cwd = join(root, "project");
	home = join(root, "home");
	await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function context(): Promise<ToolContext> {
	return {
		cwd,
		signal: new AbortController().signal,
		approval: new ApprovalChain(),
		agentId: "main",
		session: await createSession(cwd, home),
	};
}

function stubRuntime(
	codeSearch: CodeIndexService | undefined,
	features: Settings["features"],
): OrchestrationRuntime {
	return {
		session: {
			id: "test",
			filePath: join(root, "session.jsonl"),
			append: async () => {},
		},
		cwd,
		approval: new ApprovalChain(),
		maxParallelTasks: 10,
		planMaxRevisions: 3,
		permissionMode: { mode: "ask-on-dangerous" },
		features,
		codeSearch,
		resolveModel: () => {
			throw new Error("not used");
		},
		spawn: async () => ({ agentId: "worker-1" }),
	};
}

describe("createCodeSearchTool", () => {
	it("按 score 降序返回相对路径、行号、score 与最多 800 字符的 excerpt", async () => {
		const results: CodeSearchResult[] = [
			{
				path: "src/lower.ts",
				startLine: 3,
				endLine: 4,
				score: 0.2,
				excerpt: "lower",
			},
			{
				path: "src/higher.ts",
				startLine: 8,
				endLine: 9,
				score: 0.9,
				excerpt: "x".repeat(1200),
			},
		];
		const service: CodeIndexService = {
			async search(query, limit, signal) {
				expect(query).toBe("authentication");
				expect(limit).toBe(2);
				expect(signal.aborted).toBe(false);
				return results;
			},
		};
		const tool = createCodeSearchTool(service);

		const output = await tool.execute(
			{ query: "authentication", limit: 2 },
			await context(),
		);
		const parsed = JSON.parse(output.content) as CodeSearchResult[];

		expect(tool.name).toBe("code_search");
		expect(parsed.map((result) => result.path)).toEqual([
			"src/higher.ts",
			"src/lower.ts",
		]);
		expect(parsed[0]).toMatchObject({ startLine: 8, endLine: 9, score: 0.9 });
		expect(parsed[0]?.excerpt).toHaveLength(800);
		expect(output.isError).toBeUndefined();
	});

	it("无匹配时返回明确提示与空结果数组", async () => {
		const tool = createCodeSearchTool({ search: async () => [] });
		const output = await tool.execute({ query: "missing" }, await context());

		expect(output.content).toContain("No matching code found");
		expect(output.details).toEqual({ results: [] });
	});

	it("真实临时源码链路：增量索引、向量检索、结果与 vector/indexed 审计", async () => {
		const session = await createSession(cwd, home);
		await writeFile(join(cwd, "auth.ts"), "export function alphaAuth() {}\n");
		const service = createCodeIndexService({
			cwd,
			home,
			model: "embed-v1",
			embedding: {
				async embed(texts) {
					return texts.map((text) =>
						text.includes("alpha") ? [1, 0] : [0, 1],
					);
				},
			},
			onIndexed: async (audit) => {
				await session.append({
					type: "vector/indexed",
					id: "vector-1",
					ts: "2026-01-01T00:00:00.000Z",
					...audit,
				});
			},
		});
		const tool = createCodeSearchTool(service);

		const output = await tool.execute(
			{ query: "alpha" },
			{
				cwd,
				signal: new AbortController().signal,
				approval: new ApprovalChain(),
				agentId: "main",
				session,
			},
		);

		expect(JSON.parse(output.content)).toMatchObject([
			{
				path: "auth.ts",
				startLine: 1,
				endLine: 1,
				excerpt: expect.any(String),
			},
		]);
		const { events } = await loadSession(session.filePath);
		const audit = events.find(
			(event): event is Extract<SessionEvent, { type: "vector/indexed" }> =>
				event.type === "vector/indexed",
		);
		expect(audit).toMatchObject({ files: 1, chunks: 1 });
		expect(JSON.stringify(audit)).not.toContain("auth.ts");
		expect(JSON.stringify(audit)).not.toContain("alphaAuth");
	});
});

describe("code_search 角色装配", () => {
	const service: CodeIndexService = { search: async () => [] };

	it("features.vector=true 且 service 完整时向 main/worker/task 注册并加入提示词", () => {
		for (const role of ["main", "worker", "task"] as const) {
			const registry = createRoleRegistry(
				stubRuntime(service, { vector: true }),
				role,
				[],
			);
			expect(registry.get("code_search")).toBeDefined();
			const prompt = buildRoleSystemPrompt(role, {
				cwd,
				os: "darwin",
				date: "2026-01-01",
				tools: registry.declarations(),
			});
			expect(prompt).toContain("code_search");
			expect(prompt).toContain("Use code_search for semantic code discovery");
		}
	});

	it("开关关闭或 embedding service 缺失时所有角色都无 code_search", () => {
		for (const role of ["main", "worker", "task"] as const) {
			for (const runtime of [
				stubRuntime(service, { vector: false }),
				stubRuntime(undefined, { vector: true }),
				stubRuntime(service, undefined),
			]) {
				const registry = createRoleRegistry(runtime, role, []);
				expect(registry.get("code_search")).toBeUndefined();
			}
		}
	});
});
