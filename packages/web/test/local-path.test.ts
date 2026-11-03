// 会话区本地路径识别（v1）的纯函数单测 + Markdown/气泡链接化的 SSR 断言。
// 关键误报场景：URL（://）、版本号/分数、行内 code 与普通文本的渲染差异、
// 代码块（pre）与链接（<a>）子树不二次链接化。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StreamdownMarkdown from "../src/components/StreamdownMarkdown.tsx";
import {
	baseName,
	isImageFileName,
	isTextFileName,
	tokenizeLocalPaths,
	toLocalPath,
} from "../src/lib/local-path.ts";

function renderMarkdown(text: string): string {
	return renderToStaticMarkup(
		createElement(StreamdownMarkdown, { text, streaming: false }),
	);
}

describe("toLocalPath：整串路径判型", () => {
	it("合法绝对路径（含 . _ ~ + @ - 字符）命中", () => {
		expect(toLocalPath("/Users/alice/project/报告.md")).toBe(
			"/Users/alice/project/报告.md",
		);
		expect(toLocalPath("/tmp/a-b_c+d@e/f.py")).toBe("/tmp/a-b_c+d@e/f.py");
	});

	it("尾部句读/斜杠清洗后命中", () => {
		expect(toLocalPath("/a/b/c.md.")).toBe("/a/b/c.md");
		expect(toLocalPath("/a/b/c.md/")).toBe("/a/b/c.md");
	});

	it("非路径不命中：相对路径、单段、URL、Windows 盘符", () => {
		expect(toLocalPath("a/b/c.md")).toBeNull();
		expect(toLocalPath("/etc")).toBeNull();
		expect(toLocalPath("https://example.com/a/b")).toBeNull();
		expect(toLocalPath("C:\\Users\\a\\b.md")).toBeNull();
		expect(toLocalPath("")).toBeNull();
	});
});

describe("tokenizeLocalPaths：文本切分", () => {
	it("前后文本、空白与标点保留", () => {
		const tokens = tokenizeLocalPaths(
			"已生成  /tmp/out/图.png ，请查看（/a/b/c.py）。",
		);
		expect(tokens).toEqual([
			{ text: "已生成  " },
			{ text: "/tmp/out/图.png", path: "/tmp/out/图.png" },
			{ text: " ，请查看（" },
			{ text: "/a/b/c.py", path: "/a/b/c.py" },
			{ text: "）。" },
		]);
	});

	it("无路径时原样单 token 返回（调用方快速路径）", () => {
		expect(tokenizeLocalPaths("没有路径的句子 3/4 都不是。")).toEqual([
			{ text: "没有路径的句子 3/4 都不是。" },
		]);
	});

	it("URL 里的 // 与协议不当路径（负向后行）", () => {
		// https:// 已被 autolink 成 <a>，文本层兜底也不应切出路径
		expect(tokenizeLocalPaths("见 https://example.com/a/b")).toEqual([
			{ text: "见 https://example.com/a/b" },
		]);
	});
});

describe("预览分派与文件名工具", () => {
	it("文本/图片扩展名白名单（大小写不敏感）", () => {
		expect(isTextFileName("a.MD")).toBe(true);
		expect(isTextFileName("b.ts")).toBe(true);
		expect(isTextFileName("c.py")).toBe(true);
		expect(isTextFileName("d.png")).toBe(false);
		expect(isImageFileName("e.PNG")).toBe(true);
		expect(isImageFileName("f.webp")).toBe(true);
		expect(isImageFileName("g.md")).toBe(false);
		expect(isTextFileName("无扩展名")).toBe(false);
	});

	it("baseName：取末段、兼容末尾斜杠", () => {
		expect(baseName("/a/b/c/")).toBe("c");
		expect(baseName("/a/b/c.md")).toBe("c.md");
	});
});

describe("Markdown 链接化（SSR）", () => {
	it("行内 code 恰为本地路径 → 渲染为可点击 button", () => {
		const html = renderMarkdown("打开 `/tmp/out/report.md` 看看");
		expect(html).toContain("<button");
		expect(html).toContain("/tmp/out/report.md");
	});

	it("正文裸路径 → 可点击；同句其余文本不受影响", () => {
		const html = renderMarkdown("文件在 /tmp/out/report.md 里");
		expect(html).toContain("<button");
		expect(html).toContain("/tmp/out/report.md");
	});

	it("围栏代码块里的路径不链接化", () => {
		const html = renderMarkdown("```\n/tmp/out/report.md\n```");
		expect(html).toContain("/tmp/out/report.md");
		// 代码块动作按钮是 streamdown 自带，判据用 LocalPathLink 的 title 标记
		expect(html).not.toContain('title="/tmp/out/report.md"');
	});

	it("markdown 链接文本里的路径不二次链接化", () => {
		const html = renderMarkdown("[/tmp/out/report.md](https://example.com)");
		expect(html).not.toContain('title="/tmp/out/report.md"');
	});

	it("普通行内 code 保持 code 渲染", () => {
		const html = renderMarkdown("用 `pnpm test` 跑测试");
		expect(html).toContain("<code");
		expect(html).not.toContain("<button");
	});
});
