// 系统提示词 section 注册表：模块级单例，各功能模块注册自己的段，buildSystemPrompt 按 order 升序拼接
// 设计对齐 docs/archive/02-architecture.md 第 3 节（借鉴 dsh/pi 的 section 注册表）

import type { ToolDeclaration } from "@hotpot/ai";

// 构建系统提示词时可见的上下文；date 由调用方传入，保证测试可固定
export type PromptContext = {
	cwd: string;
	os: string;
	date: string;
	tools: ToolDeclaration[];
};

// text 为静态字符串或按 ctx 动态产出的函数
export interface PromptSection {
	name: string;
	order: number;
	text: string | ((ctx: PromptContext) => string);
}

// 模块级单例注册表；同 order 保持注册先后（排序稳定）
const registeredSections: PromptSection[] = [];

export function registerSection(s: PromptSection): void {
	registeredSections.push(s);
}

// 仅供测试隔离使用：清空注册表（含默认段），业务代码不得调用
export function resetSections(): void {
	registeredSections.length = 0;
}

// 按 order 升序拼接各段文本，段间以空行分隔
// sections 默认时读模块级注册表；传入局部段列表则绕过全局单例
// （orchestrator 按角色组装 prompt 时用后者，避免多角色在同进程构建时互相污染注册表）
export function buildSystemPrompt(
	ctx: PromptContext,
	sections?: readonly PromptSection[],
): string {
	const source = sections ?? registeredSections;
	const sorted = [...source].sort((a, b) => a.order - b.order);
	return sorted
		.map((s) => (typeof s.text === "function" ? s.text(ctx) : s.text))
		.join("\n\n");
}
