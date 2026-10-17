// Markdown 子集渲染测试：无 HTML 注入面（renderToStaticMarkup 转义断言）、
// 行内格式结构、空输入与畸形输入不抛。node 环境无 DOM，用 react-dom/server 断言输出。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/components/Markdown.tsx";

function render(text: string): string {
	return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("Markdown 渲染", () => {
	it("代码块中的 <script> 字面量被转义，无 HTML 注入面", () => {
		const html = render("```\n<script>alert(1)</script>\n```");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("普通文本中的 HTML 同样被转义", () => {
		const html = render("点击 <b>这里</b>");
		expect(html).toContain("&lt;b&gt;");
		expect(html).not.toContain("<b>");
	});

	it("围栏代码块原样输出为 pre/code", () => {
		const html = render("前文\n```ts\nconst a = 1;\n```\n后文");
		expect(html).toContain("<pre><code>const a = 1;</code></pre>");
	});

	it("标题 #/##/### 渲染为 h1/h2/h3", () => {
		expect(render("# 一")).toContain("<h1>一</h1>");
		expect(render("## 二")).toContain("<h2>二</h2>");
		expect(render("### 三")).toContain("<h3>三</h3>");
	});

	it("行内代码与粗体渲染为 code/strong", () => {
		const html = render("使用 `pnpm test` 运行 **全部** 测试");
		expect(html).toContain("<code>pnpm test</code>");
		expect(html).toContain("<strong>全部</strong>");
	});

	it("无序列表渲染为 ul/li，连续行归一个列表", () => {
		const html = render("- 甲\n- 乙");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>甲</li>");
		expect(html).toContain("<li>乙</li>");
	});

	it("空输入不抛且输出空", () => {
		expect(render("")).toBe("");
	});

	it("畸形输入不抛：未闭合围栏、悬垂标记、嵌套列表", () => {
		expect(() => render("```\n没有结尾")).not.toThrow();
		expect(() => render("**未闭合")).not.toThrow();
		expect(() => render("`悬垂")).not.toThrow();
		expect(() => render("- 一级\n  - 二级")).not.toThrow();
		const html = render("**未闭合");
		expect(html).toContain("**未闭合");
	});
});
