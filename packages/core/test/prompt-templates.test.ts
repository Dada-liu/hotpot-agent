// prompt templates 测试（M4 Feature⑤）：目录发现（frontmatter/文件名兜底/同名覆盖）、
// 参数展开（$ARGUMENTS/$1..$9/缺失位置参数报错）、`/name args` 解析。
// 全部用临时目录，hermetic。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverPromptTemplates,
	expandTemplate,
	isSlashInput,
	resolveSlashCommand,
} from "../src/prompt-templates.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hotpot-prompts-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function writeTemplate(
	dir: string,
	file: string,
	content: string,
): Promise<string> {
	const target = join(root, dir);
	await mkdir(target, { recursive: true });
	const path = join(target, file);
	await writeFile(path, content);
	return path;
}

describe("discoverPromptTemplates", () => {
	it("frontmatter 提供 name/description，正文去掉围栏", async () => {
		const path = await writeTemplate(
			"p1",
			"commit.md",
			"---\nname: commit\ndescription: Write commits\n---\nPlease commit: $ARGUMENTS\n",
		);
		const [tpl] = await discoverPromptTemplates([join(root, "p1")]);
		expect(tpl).toEqual({
			name: "commit",
			description: "Write commits",
			path,
			body: "Please commit: $ARGUMENTS\n",
		});
	});

	it("无 frontmatter：name 取文件名（去 .md），description 空串", async () => {
		await writeTemplate("p1", "review.md", "Review $1 please\n");
		const [tpl] = await discoverPromptTemplates([join(root, "p1")]);
		expect(tpl?.name).toBe("review");
		expect(tpl?.description).toBe("");
		expect(tpl?.body).toBe("Review $1 please\n");
	});

	it("目录不存在静默跳过；非 .md 文件忽略；只扫一级", async () => {
		await writeTemplate("p1", "keep.md", "keep\n");
		await writeTemplate("p1", "notes.txt", "not a template\n");
		await writeTemplate(join("p1", "nested"), "deep.md", "deep\n");
		const templates = await discoverPromptTemplates([
			join(root, "missing"),
			join(root, "p1"),
		]);
		expect(templates.map((t) => t.name)).toEqual(["keep"]);
	});

	it("同名模板后扫描目录覆盖先扫描目录", async () => {
		await writeTemplate("home", "dup.md", "---\nname: dup\n---\nhome body\n");
		await writeTemplate(
			"project",
			"other.md",
			"---\nname: dup\n---\nproject body\n",
		);
		const templates = await discoverPromptTemplates([
			join(root, "home"),
			join(root, "project"),
		]);
		expect(templates).toHaveLength(1);
		expect(templates[0]?.body).toBe("project body\n");
	});
});

describe("expandTemplate", () => {
	const base = {
		name: "t",
		description: "",
		path: "/x.md",
		body: "",
	};

	it("$ARGUMENTS 展开为全部参数（空格连接）", () => {
		const out = expandTemplate({ ...base, body: "run $ARGUMENTS now" }, [
			"a",
			"b",
		]);
		expect(out).toBe("run a b now");
	});

	it("$1..$9 按位置替换，可重复引用", () => {
		const out = expandTemplate({ ...base, body: "$1 then $2 then $1" }, [
			"alpha",
			"beta",
		]);
		expect(out).toBe("alpha then beta then alpha");
	});

	it("引用的位置参数超过实参数量：抛明确错误", () => {
		expect(() => expandTemplate({ ...base, body: "need $2" }, ["one"])).toThrow(
			/prompt template "t" requires at least 2 argument\(s\), got 1/,
		);
	});

	it("未引用的模板忽略多余参数", () => {
		expect(expandTemplate({ ...base, body: "plain" }, ["x"])).toBe("plain");
	});
});

describe("resolveSlashCommand / isSlashInput", () => {
	const templates = [
		{
			name: "commit",
			description: "",
			path: "/commit.md",
			body: "commit $ARGUMENTS",
		},
		{
			name: "review",
			description: "",
			path: "/review.md",
			body: "review",
		},
	];

	it("解析 /name 与参数（连续空白折叠）", () => {
		const match = resolveSlashCommand("/commit  fix   lint", templates);
		expect(match?.template.name).toBe("commit");
		expect(match?.args).toEqual(["fix", "lint"]);
	});

	it("无参数的命令返回空参数数组", () => {
		expect(resolveSlashCommand("/review", templates)?.args).toEqual([]);
	});

	it("未命中模板或非斜杠输入返回 null", () => {
		expect(resolveSlashCommand("/nope", templates)).toBeNull();
		expect(resolveSlashCommand("hello", templates)).toBeNull();
	});

	it("isSlashInput 只认首个非空白字符是 /", () => {
		expect(isSlashInput("  /commit x")).toBe(true);
		expect(isSlashInput("hello /commit")).toBe(false);
	});
});
