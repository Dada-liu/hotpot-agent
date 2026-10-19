// 默认系统提示词段：identity / tools / rules / env，order 常量集中分配，段间留出插件插入空间
// 注意：以下 prompt 文案为 LLM 面向文本，按约定必须全英文（AGENTS.md）

import {
	type PromptContext,
	type PromptSection,
	registerSection,
} from "./sections.ts";

// 默认段 order 常量：以 1000 为间隔，便于未来在两段之间插入新段
export const SECTION_ORDER = {
	IDENTITY: 0,
	TOOLS: 1000,
	RULES: 2000,
	ENV: 3000,
} as const;

const IDENTITY_TEXT = `You are hotpot-agent, a coding agent running in the user's terminal.
Principles: low cost, high effect — solve the task in the fewest necessary steps.
Prefer tools over guessing; execute carefully and verify results before claiming done.`;

function toolsText(ctx: PromptContext): string {
	if (ctx.tools.length === 0) {
		return "No tools are available.";
	}
	const lines = ctx.tools.map((t) => `- ${t.name}: ${t.description}`);
	return `Available tools:\n${lines.join("\n")}`;
}

const RULES_TEXT = `Tool use rules:
- Read a file before editing it.
- Destructive or hard-to-reverse bash commands require explicit user approval.
- Prefer dedicated tools over shell workarounds when both exist.`;

function envText(ctx: PromptContext): string {
	return `Environment:
- OS: ${ctx.os}
- Working directory: ${ctx.cwd}
- Date: ${ctx.date}`;
}

// 四个默认段导出为对象：注册进全局单例之外的调用方（如 orchestrator 按角色组段）
// 可直接复用同一份段定义，配合 buildSystemPrompt 的局部 sections 入参绕过全局注册表
export const identitySection: PromptSection = {
	name: "identity",
	order: SECTION_ORDER.IDENTITY,
	text: IDENTITY_TEXT,
};

export const toolsSection: PromptSection = {
	name: "tools",
	order: SECTION_ORDER.TOOLS,
	text: toolsText,
};

export const rulesSection: PromptSection = {
	name: "rules",
	order: SECTION_ORDER.RULES,
	text: RULES_TEXT,
};

export const envSection: PromptSection = {
	name: "env",
	order: SECTION_ORDER.ENV,
	text: envText,
};

// 注册四个默认段；调用前通常先 resetSections()（测试）或在进程启动时调用一次
export function registerDefaultSections(): void {
	registerSection(identitySection);
	registerSection(toolsSection);
	registerSection(rulesSection);
	registerSection(envSection);
}
