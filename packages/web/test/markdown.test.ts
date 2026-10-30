// Markdown 渲染测试（streamdown 版）：无 HTML 注入面（renderToStaticMarkup 转义断言）、
// GFM 结构、公式渲染、空输入与畸形输入不抛。node 环境无 DOM，用 react-dom/server 断言输出。
// 直接测 StreamdownMarkdown 本体；Markdown.tsx 的 React.lazy 包装不支持 SSR，不在此测。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StreamdownMarkdown from "../src/components/StreamdownMarkdown.tsx";

function render(text: string, streaming = false): string {
	return renderToStaticMarkup(
		createElement(StreamdownMarkdown, { text, streaming }),
	);
}

describe("Markdown 渲染", () => {
	it("代码块中的 <script> 字面量被转义，无 HTML 注入面", () => {
		const html = render("```\n<script>alert(1)</script>\n```");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("raw HTML 由 rehype-harden 处理：script/iframe 整体剥离，无注入面", () => {
		const html = render(
			"a <script>alert(1)</script> <iframe src=x></iframe> b",
		);
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("alert(1)");
		expect(html).toMatch(/a\s+b/);
	});

	it("带 onerror 的图片被安全层拦截为占位", () => {
		const html = render('a <img src=x onerror="alert(1)"> b');
		expect(html).not.toContain("onerror");
		expect(html).toContain("a");
		expect(html).toContain("b");
	});

	it("围栏代码块渲染为 pre，代码文本保留", () => {
		const html = render("前文\n```ts\nconst a = 1;\n```\n后文");
		expect(html).toContain("<pre");
		expect(html).toContain("const a = 1;");
	});

	it("标题 #/##/### 渲染为 h1/h2/h3", () => {
		expect(render("# 一")).toContain("<h1");
		expect(render("# 一")).toContain("一");
		expect(render("## 二")).toContain("<h2");
		expect(render("### 三")).toContain("<h3");
	});

	it("行内代码渲染为 code，粗体渲染为 strong（streamdown 默认带 data-streamdown 标记）", () => {
		const html = render("使用 `pnpm test` 运行 **全部** 测试");
		expect(html).toContain("<code");
		expect(html).toContain("pnpm test");
		expect(html).toContain('data-streamdown="strong"');
		expect(html).toContain("全部");
	});

	it("无序列表渲染为 ul/li", () => {
		const html = render("- 甲\n- 乙");
		expect(html).toContain("<ul");
		expect(html).toContain("<li");
		expect(html).toContain("甲");
		expect(html).toContain("乙");
	});

	it("GFM 表格渲染为 table，表头单元格保留", () => {
		const html = render("| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |");
		expect(html).toContain("<table");
		expect(html).toContain("名称");
		expect(html).toContain("<th");
		expect(html).toContain("<td");
	});

	it("GFM 嵌套/有序列表渲染不抛且结构正确", () => {
		const html = render("1. 甲\n2. 乙\n   - 丙");
		expect(html).toContain("<ol");
		expect(html).toContain("丙");
	});

	it("行内公式渲染出 katex 结构", () => {
		const html = render("质能方程 $E=mc^2$ 很有名");
		expect(html).toContain("katex");
		expect(html).toContain("E=");
	});

	it("块级公式渲染不抛", () => {
		expect(() => render("$$\n\\int_0^1 x^2 dx\n$$")).not.toThrow();
	});

	it("不安全链接协议被安全层拦截", () => {
		const html = render("[点击](javascript:alert(1))");
		expect(html).not.toContain("javascript:alert");
	});

	it("空输入输出空（包装层 Markdown 对空文本返回 null）", () => {
		expect(() => render("")).not.toThrow();
		expect(render("").replace(/<[^>]*>/g, "")).toBe("");
	});

	it("畸形输入不抛：未闭合围栏、悬垂标记、嵌套列表", () => {
		expect(() => render("```\n没有结尾")).not.toThrow();
		expect(() => render("**未闭合")).not.toThrow();
		expect(() => render("`悬垂")).not.toThrow();
		expect(() => render("- 一级\n  - 二级")).not.toThrow();
		const html = render("**未闭合");
		expect(html).toContain("未闭合");
	});

	it("流式模式：未闭合围栏与半个公式不抛", () => {
		expect(() => render("```\n没有结尾", true)).not.toThrow();
		expect(() => render("公式 $E=mc", true)).not.toThrow();
		expect(() => render("```mermaid\ngraph TD;A-->", true)).not.toThrow();
	});
});
