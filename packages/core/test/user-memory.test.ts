import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalChain } from "../src/approval/chain.ts";
import type { SessionEvent } from "../src/session/events.ts";
import type { ToolContext } from "../src/tools/tool.ts";
import {
	appendMemory,
	createMemorySaveTool,
	readMemorySummary,
} from "../src/user-memory/index.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-user-memory-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function memoryPath(): string {
	return join(home, "MEMORY.md");
}

function makeCtx(agentId: string, events: SessionEvent[]): ToolContext {
	return {
		cwd: home,
		signal: new AbortController().signal,
		approval: new ApprovalChain(),
		agentId,
		session: {
			id: "test-session",
			filePath: join(home, "session.jsonl"),
			append: async (event: SessionEvent) => {
				events.push(event);
			},
		},
	};
}

describe("appendMemory", () => {
	it("首次写入创建标题和 Markdown 列表项", async () => {
		await appendMemory("  Prefers concise answers  ", home);

		expect(await readFile(memoryPath(), "utf8")).toBe(
			"# User Memory\n- Prefers concise answers\n",
		);
	});

	it("重复追加保留已有条目不重复标题", async () => {
		await appendMemory("first", home);
		await appendMemory("second", home);

		expect(await readFile(memoryPath(), "utf8")).toBe(
			"# User Memory\n- first\n- second\n",
		);
	});

	it("人工已有 Markdown 原样保留，无末尾换行也能继续追加", async () => {
		const existing = "# My notes\n\nManual introduction";
		await writeFile(memoryPath(), existing);

		await appendMemory("likes tea", home);

		expect(await readFile(memoryPath(), "utf8")).toBe(
			`${existing}\n- likes tea\n`,
		);
	});

	it("多行内容写成一个列表项，续行缩进而非拆成多个条目", async () => {
		await appendMemory(
			"  Prefers:\r\nTypeScript\r\n\r\nKeep it concise  ",
			home,
		);

		expect(await readFile(memoryPath(), "utf8")).toBe(
			"# User Memory\n- Prefers:\n  TypeScript\n  \n  Keep it concise\n",
		);
	});

	it("空内容拒绝且不创建文件", async () => {
		await expect(appendMemory(" \n\t ", home)).rejects.toThrow(/empty/i);

		await expect(readFile(memoryPath(), "utf8")).rejects.toThrow();
	});
});

describe("readMemorySummary", () => {
	it("文件不存在返回空字符串", async () => {
		expect(await readMemorySummary(home)).toBe("");
	});

	it("跨调用实例读取同一份持久化内容", async () => {
		await appendMemory("stable preference", home);

		expect(await readMemorySummary(home)).toBe(
			"# User Memory\n- stable preference\n",
		);
	});

	it("空文件和无标题的人工 Markdown 均可读取", async () => {
		await writeFile(memoryPath(), "");
		expect(await readMemorySummary(home)).toBe("");

		await writeFile(memoryPath(), "favorite editor: vim\n");
		expect(await readMemorySummary(home)).toBe("favorite editor: vim\n");
	});

	it("超过 8000 字符时保留末尾完整多行条目并标注截断", async () => {
		const oldEntry = `- old ${"x".repeat(8000)}`;
		const latestEntry = "- latest preference\n  with a continuation line";
		await writeFile(
			memoryPath(),
			`# User Memory\n${oldEntry}\n- middle entry\n${latestEntry}\n`,
		);

		const summary = await readMemorySummary(home);

		expect(summary.length).toBeLessThanOrEqual(8000);
		expect(summary).toMatch(/truncated/i);
		expect(summary).toContain("- middle entry");
		expect(summary.endsWith(latestEntry)).toBe(true);
		expect(summary).not.toContain("old xxx");
	});

	it("读取失败降级为空字符串", async () => {
		await mkdir(memoryPath());

		expect(await readMemorySummary(home)).toBe("");
	});
});

describe("createMemorySaveTool", () => {
	it("实际写入 MEMORY.md 并落不含正文的 memory/saved 审计事件", async () => {
		const events: SessionEvent[] = [];
		const tool = createMemorySaveTool(home);

		const output = await tool.execute(
			{ content: "Use pnpm for this repository" },
			makeCtx("worker-1", events),
		);

		expect(tool.name).toBe("memory_save");
		expect(tool.isConcurrencySafe).toBe(false);
		expect(output.isError ?? false).toBe(false);
		expect(await readFile(memoryPath(), "utf8")).toBe(
			"# User Memory\n- Use pnpm for this repository\n",
		);
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event).toEqual({
			type: "memory/saved",
			id: expect.any(String),
			ts: expect.any(String),
			agentId: "worker-1",
		});
		if (event?.type === "memory/saved") {
			expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
		}
		expect(JSON.stringify(event)).not.toContain("Use pnpm");
	});

	it("写入失败返回 isError 且不生成成功审计事件", async () => {
		await mkdir(memoryPath());
		const events: SessionEvent[] = [];
		const tool = createMemorySaveTool(home);

		const output = await tool.execute(
			{ content: "must not be persisted" },
			makeCtx("main", events),
		);

		expect(output.isError).toBe(true);
		expect(output.content).toMatch(/failed/i);
		expect(events).toEqual([]);
	});

	it("空白内容返回 isError 且不创建文件或事件", async () => {
		const events: SessionEvent[] = [];
		const tool = createMemorySaveTool(home);

		const output = await tool.execute(
			{ content: " \n " },
			makeCtx("main", events),
		);

		expect(output.isError).toBe(true);
		expect(events).toEqual([]);
		await expect(readFile(memoryPath(), "utf8")).rejects.toThrow();
	});
});
