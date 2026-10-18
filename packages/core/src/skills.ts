// skill 发现（M4 Feature④）：递归扫描给定目录下的 SKILL.md，解析 frontmatter
// 里的 name/description（渐进式加载——清单只进 prompt，模型用 read 工具按 path 读正文）。
// frontmatter 只支持最小 YAML 子集：`---` 围栏内的 `key: value` 行，只取 name/description
// 两个键；name 缺省取 SKILL.md 所在目录名（basename），description 缺省空串。
// 目录不存在/不可读静默跳过；同名 skill 后扫描的目录优先（Map 后写覆盖先写，按 name 去重）。

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export interface Skill {
	name: string;
	description: string;
	path: string;
}

// 扫描 dirs（按给定顺序）下所有 SKILL.md，返回去重后的 skill 清单。
// 同名后者覆盖前者，因此调用方把优先级高的目录排在后面。
export async function discoverSkills(dirs: string[]): Promise<Skill[]> {
	const byName = new Map<string, Skill>();
	for (const dir of dirs) {
		for (const skill of await scanDir(dir)) {
			byName.set(skill.name, skill);
		}
	}
	return [...byName.values()];
}

// 递归找 dir 下的 SKILL.md；目录不存在/不可读返回空（静默跳过，不抛错）
async function scanDir(dir: string): Promise<Skill[]> {
	let entries: HotpotDirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: Skill[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			skills.push(...(await scanDir(full)));
		} else if (entry.isFile() && entry.name === "SKILL.md") {
			skills.push(await parseSkillFile(full));
		}
	}
	return skills;
}

// 解析单个 SKILL.md：读失败按「无 frontmatter」兜底（name 取目录名、description 空串），
// 不让一个坏文件中断整个扫描
async function parseSkillFile(path: string): Promise<Skill> {
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch {
		// 读失败（权限/竞态删除）：按缺 frontmatter 处理
	}
	const meta = parseFrontmatter(text);
	const name =
		meta.name !== undefined && meta.name !== ""
			? meta.name
			: basename(dirname(path));
	return {
		name,
		description: meta.description ?? "",
		path,
	};
}
