// prompt templates（M4 Feature⑤）：`prompts/*.md` → `/命令`，支持参数占位。
// 目录约定与 skill 一致：settings.promptsDirs（相对 cwd）+ <home>/prompts +
// <cwd>/.hotpot/prompts；后扫描的同名模板覆盖先扫描的（项目级优先）。
// 文件格式：可选 frontmatter（name/description），正文即模板；placeholders：
//   $ARGUMENTS  全部参数以空格连接
//   $1..$9      位置参数；引用超过实参数量的位置参数报明确错误
// 模板展开本身不落盘；调用方（CLI / server）在展开后追加 prompt/invoked 事件。

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export interface PromptTemplate {
	name: string;
	description: string;
	path: string;
	// 去掉 frontmatter 后的正文（展开的输入）
	body: string;
}

// 去掉首部 frontmatter（与 parseFrontmatter 的围栏规则一致）
function stripFrontmatter(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") {
		return text;
	}
	for (let i = 1; i < lines.length; i++) {
		if ((lines[i] ?? "").trim() === "---") {
			return lines.slice(i + 1).join("\n");
		}
	}
	// 无收尾围栏：整个文件都是 frontmatter（宽容处理）
	return "";
}

// 扫描 dirs（按给定顺序）下的 *.md 模板；目录不存在/不可读静默跳过。
// 只扫目录一级（不递归），同名后者覆盖前者——调用方把优先级高的目录排在后面。
export async function discoverPromptTemplates(
	dirs: string[],
): Promise<PromptTemplate[]> {
	const byName = new Map<string, PromptTemplate>();
	for (const dir of dirs) {
		let entries: HotpotDirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) {
				continue;
			}
			const path = join(dir, entry.name);
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch {
				continue; // 读失败（权限/竞态删除）跳过单个文件
			}
			const meta = parseFrontmatter(text);
			const name =
				meta.name !== undefined && meta.name !== ""
					? meta.name
					: basename(path, ".md");
			byName.set(name, {
				name,
				description: meta.description ?? "",
				path,
				body: stripFrontmatter(text),
			});
		}
	}
	return [...byName.values()];
}

// 模板正文里引用的最大位置参数序号；无引用返回 0
function maxPositionalRef(body: string): number {
	let max = 0;
	for (const m of body.matchAll(/\$([1-9])/g)) {
		max = Math.max(max, Number(m[1]));
	}
	return max;
}

// 展开模板：$ARGUMENTS → 参数空格连接；$1..$9 → 对应位置参数。
// 引用的位置参数超过实参数量时抛错（调用方决定是报错还是当普通消息）。
export function expandTemplate(
	template: PromptTemplate,
	args: string[],
): string {
	const required = maxPositionalRef(template.body);
	if (args.length < required) {
		throw new Error(
			`prompt template "${template.name}" requires at least ${required} argument(s), got ${args.length}`,
		);
	}
	const withArguments = template.body.replaceAll("$ARGUMENTS", args.join(" "));
	return withArguments.replace(
		/\$([1-9])/g,
		(_match, digit: string) => args[Number(digit) - 1] ?? "",
	);
}

export interface SlashCommandMatch {
	template: PromptTemplate;
	args: string[];
}

// 解析 `/name args`：不是斜杠命令、或命令名未命中模板时返回 null。
// 参数按空白切分（连续空白折叠），不支持引号分组——M4 保持最小语义。
export function resolveSlashCommand(
	input: string,
	templates: readonly PromptTemplate[],
): SlashCommandMatch | null {
	const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
	if (match === null) {
		return null;
	}
	const name = match[1] ?? "";
	const template = templates.find((t) => t.name === name);
	if (template === undefined) {
		return null;
	}
	const rest = (match[2] ?? "").trim();
	return {
		template,
		args: rest === "" ? [] : rest.split(/\s+/),
	};
}

// 输入是否看起来是斜杠命令（用于区分「未知命令」与普通消息）
export function isSlashInput(input: string): boolean {
	return input.trim().startsWith("/");
}
