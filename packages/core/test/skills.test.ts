// discoverSkills 测试：frontmatter 解析（围栏/key: value/缺键兜底）、递归目录扫描、
// 目录不存在静默跳过、同名去重（后扫描目录优先）。全部用临时目录，hermetic。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills } from "../src/skills/skills.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hotpot-skills-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

// 在 root 下建 <dir>/SKILL.md；frontmatter 为 null 表示整个文件只写 body
async function makeSkill(
	dir: string,
	frontmatter: string | null,
	body = "# Skill body\n",
): Promise<string> {
	const skillDir = join(root, dir);
	await mkdir(skillDir, { recursive: true });
	const path = join(skillDir, "SKILL.md");
	await writeFile(
		path,
		frontmatter === null ? body : `---\n${frontmatter}---\n${body}`,
	);
	return path;
}

describe("frontmatter 解析", () => {
	it("取 name/description 两个键，忽略其余键与正文", async () => {
		const path = await makeSkill(
			"commit",
			"name: commit\ndescription: Write conventional commits\nversion: 2\n",
		);
		const [skill] = await discoverSkills([root]);
		expect(skill).toEqual({
			name: "commit",
			description: "Write conventional commits",
			path,
		});
	});

	it("name 默认取所在目录名 basename，description 默认空串", async () => {
		const path = await makeSkill("my-skill", "description: 一些说明\n");
		const [skill] = await discoverSkills([root]);
		expect(skill?.name).toBe("my-skill");
		expect(skill?.description).toBe("一些说明");
		expect(skill?.path).toBe(path);
	});

	it("无 frontmatter（首行不是 ---）时 name/description 全走默认", async () => {
		await makeSkill("plain", null, "随便什么内容\nname: 不在围栏里不生效\n");
		const [skill] = await discoverSkills([root]);
		expect(skill?.name).toBe("plain");
		expect(skill?.description).toBe("");
	});

	it("description 含冒号时值取第一个冒号后的全部内容", async () => {
		await makeSkill("tricky", "name: tricky\ndescription: do: this\n");
		const [skill] = await discoverSkills([root]);
		expect(skill?.description).toBe("do: this");
	});

	it("name 为空白字符串时同样兜底目录名", async () => {
		await makeSkill("fallback", "name:\n");
		const [skill] = await discoverSkills([root]);
		expect(skill?.name).toBe("fallback");
	});
});

describe("目录扫描", () => {
	it("递归发现嵌套子目录里的 SKILL.md", async () => {
		await makeSkill("a", "name: a\n");
		await makeSkill(join("group", "b"), "name: b\n");
		const skills = await discoverSkills([root]);
		expect(skills.map((s) => s.name).sort()).toEqual(["a", "b"]);
	});

	it("目录不存在静默跳过，不影响其余目录", async () => {
		await makeSkill("real", "name: real\n");
		const skills = await discoverSkills([
			join(root, "not-exist"),
			join(root, "real"),
		]);
		expect(skills.map((s) => s.name)).toEqual(["real"]);
	});

	it("非 SKILL.md 文件与普通目录不会被当成 skill", async () => {
		await mkdir(join(root, "notes"), { recursive: true });
		await writeFile(join(root, "notes", "README.md"), "# not a skill\n");
		await writeFile(join(root, "SKILL.md.bak"), "junk\n");
		const skills = await discoverSkills([root]);
		expect(skills).toEqual([]);
	});

	it("同名 skill 后扫描的目录优先（按 name 去重）", async () => {
		await makeSkill(join("first", "dup"), "name: dup\ndescription: first\n");
		await makeSkill(join("second", "dup"), "name: dup\ndescription: second\n");
		// 先扫的目录优先时 first 赢；契约是「后扫描优先」，所以 second 赢
		const skills = await discoverSkills([
			join(root, "first"),
			join(root, "second"),
		]);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("second");
	});

	it("空目录清单返回空数组", async () => {
		expect(await discoverSkills([])).toEqual([]);
	});
});
