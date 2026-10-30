// Markdown 渲染本体：streamdown（为流式场景设计的 react-markdown 替代）。
// 能力：GFM（表格/删除线/任务列表）、shiki 代码高亮（@streamdown/code）、
// KaTeX 公式（@streamdown/math）、mermaid 图（手写懒加载插件，见下）、CJK 排版修正（@streamdown/cjk）。
// 安全：streamdown 内置 rehype-harden 安全层，script/iframe 整体剥离、图片/链接走协议白名单，
// 与旧手写渲染器一样无 HTML 注入面。
// 本组件经 Markdown.tsx 的 React.lazy 异步加载，重量级依赖（shiki/katex）不进首屏主 chunk。

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { MermaidConfig } from "mermaid";
import type { ReactElement } from "react";
import { type DiagramPlugin, Streamdown } from "streamdown";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";

// mermaid 懒加载插件：不用 @streamdown/mermaid，因为它对 mermaid 核心是顶层静态 import，
// 会把 ~1.7MB 的 mermaid（含 cytoscape 布局）绑进 markdown 渲染 chunk；
// 这里首次渲染图时才动态 import，Vite 会拆成独立异步 chunk（本文件唯一的动态 import，
// 代码分割点约定见 packages/web/AGENTS.md）。
// securityLevel "strict"：禁用 click 回调与 HTML 标签，渲染结果无脚本面。
const mermaidConfig: MermaidConfig = {
	startOnLoad: false,
	theme: "default",
	securityLevel: "strict",
	fontFamily: "monospace",
};

let mermaidModule: Promise<typeof import("mermaid")> | undefined;

const mermaid: DiagramPlugin = {
	name: "mermaid",
	type: "diagram",
	language: "mermaid",
	getMermaid() {
		return {
			initialize(config?: Record<string, unknown>) {
				Object.assign(mermaidConfig, config);
			},
			async render(id: string, source: string) {
				mermaidModule ??= import("mermaid");
				const mermaidLib = (await mermaidModule).default;
				mermaidLib.initialize(mermaidConfig);
				return mermaidLib.render(id, source);
			},
		};
	},
};

// 行内 $...$ 也按公式解析（与 dsh 的默认一致）；不成对的单个 $ 不会误判，
// 闭合对要求内部首尾非空格，普通美元金额（"$100"）不受影响。
const math = createMathPlugin({ singleDollarTextMath: true });

export default function StreamdownMarkdown({
	text,
	streaming,
}: {
	text: string;
	streaming: boolean;
}): ReactElement {
	return (
		<Streamdown
			mode={streaming ? "streaming" : "static"}
			parseIncompleteMarkdown={streaming}
			animated={false}
			plugins={{ code, math, cjk, mermaid }}
		>
			{text}
		</Streamdown>
	);
}
