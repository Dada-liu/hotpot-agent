import type { ToolDeclaration } from "@hotpot/ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	registerDefaultSections,
	SECTION_ORDER,
} from "../src/prompt/default-sections.ts";
import {
	buildSystemPrompt,
	registerSection,
	resetSections,
} from "../src/prompt/sections.ts";

// 固定 ctx，保证测试确定性；prompt 文案必须全英文
const CTX = {
	cwd: "/Users/test/project",
	os: "darwin",
	date: "2026-10-10",
	tools: [
		{
			name: "read",
			description: "Read a file from disk",
			parameters: { type: "object" },
		},
		{
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object" },
		},
	] satisfies ToolDeclaration[],
};

// 每个用例前清空注册表，保证用例间隔离
beforeEach(() => {
	resetSections();
});

describe("section registry", () => {
	it("乱序注册后 buildSystemPrompt 按 order 升序拼接，段间空行分隔", () => {
		registerSection({ name: "late", order: 20, text: "late section" });
		registerSection({ name: "early", order: 5, text: "early section" });
		registerSection({ name: "middle", order: 10, text: "middle section" });

		const prompt = buildSystemPrompt(CTX);
		expect(prompt).toBe("early section\n\nmiddle section\n\nlate section");
	});

	it("函数型 section 收到 ctx，可动态产出文本", () => {
		registerSection({
			name: "dynamic",
			order: 1,
			text: (ctx) => `cwd is ${ctx.cwd}, os is ${ctx.os}, date is ${ctx.date}`,
		});

		const prompt = buildSystemPrompt(CTX);
		expect(prompt).toBe(
			"cwd is /Users/test/project, os is darwin, date is 2026-10-10",
		);
	});

	it("传入局部 sections 时绕过全局注册表，全局段不参与拼接", () => {
		registerSection({ name: "global", order: 1, text: "global section" });

		const prompt = buildSystemPrompt(CTX, [
			{ name: "local-a", order: 5, text: "a" },
			{ name: "local-b", order: 2, text: "b" },
		]);

		expect(prompt).toBe("b\n\na");
	});
});

describe("default sections", () => {
	it("默认四段按 SECTION_ORDER 顺序输出", () => {
		registerDefaultSections();
		const prompt = buildSystemPrompt(CTX);

		const identityIdx = prompt.indexOf("hotpot-code");
		const toolsIdx = prompt.indexOf("Available tools");
		const rulesIdx = prompt.indexOf("Tool use rules");
		const envIdx = prompt.indexOf("Environment");
		expect(identityIdx).toBeGreaterThanOrEqual(0);
		expect(toolsIdx).toBeGreaterThan(identityIdx);
		expect(rulesIdx).toBeGreaterThan(toolsIdx);
		expect(envIdx).toBeGreaterThan(rulesIdx);
	});

	it("tools 段动态列出 ctx.tools 的名称与描述", () => {
		registerDefaultSections();
		const prompt = buildSystemPrompt(CTX);

		expect(prompt).toContain("read");
		expect(prompt).toContain("Read a file from disk");
		expect(prompt).toContain("bash");
		expect(prompt).toContain("Run a shell command");
	});

	it("env 段包含 cwd / os / date", () => {
		registerDefaultSections();
		const prompt = buildSystemPrompt(CTX);

		expect(prompt).toContain("/Users/test/project");
		expect(prompt).toContain("darwin");
		expect(prompt).toContain("2026-10-10");
	});

	it("identity 段声明 hotpot-code 身份与核心原则（英文）", () => {
		registerDefaultSections();
		const prompt = buildSystemPrompt(CTX);

		expect(prompt).toContain("hotpot-code");
		expect(prompt).toMatch(/coding agent/i);
	});

	it("rules 段包含工具使用规范（edit 前 read、高危命令需确认）", () => {
		registerDefaultSections();
		const prompt = buildSystemPrompt(CTX);

		expect(prompt).toMatch(/[Rr]ead.*before.*edit|before editing/);
		expect(prompt).toMatch(/approv|confirm/i);
	});

	it("SECTION_ORDER 常量值固定", () => {
		expect(SECTION_ORDER).toEqual({
			IDENTITY: 0,
			TOOLS: 1000,
			RULES: 2000,
			ENV: 3000,
		});
	});
});
