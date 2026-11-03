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
import type { ComponentType, ReactElement, ReactNode } from "react";
import {
	type Components,
	type DiagramPlugin,
	defaultComponents,
	type ExtraProps,
	Streamdown,
} from "streamdown";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { toLocalPath } from "@/lib/local-path";
import { LinkifyText } from "./LinkifyText.tsx";
import { LocalPathLink } from "./LocalPathLink.tsx";

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

// 行内 code 子节点取文本（路径判型用）：纯字符串（或字符串数组）才取，其余 null
function inlineText(children: ReactNode): string | null {
	if (typeof children === "string") return children;
	if (Array.isArray(children) && children.every((c) => typeof c === "string")) {
		return children.join("");
	}
	return null;
}

// 文本容器统一包 LinkifyText：把裸本地绝对路径链接化。
// compose 内置 defaultComponents 保留默认排版样式；node 等解析内部 props
// 原样透传给内置组件（它们自行消费，不会落到 DOM）。
// node 是 hast 的 Element（@types/hast 仅为传递依赖，不直接引类型），
// 入参统一收敛为 unknown 后在内部收窄，避开各容器 props 泛型差异。
// 声明参数面只取 children，node/className 等解析 props 运行经 spread 原样透传。
// 返回值在组装 components 时统一收窄（见下）。
interface TextContainerProps {
	children?: ReactNode;
}

function linkified(tag: unknown) {
	const Tag = tag as ComponentType<TextContainerProps>;
	return function Linkified(props: TextContainerProps): ReactElement {
		return (
			<Tag {...props}>
				<LinkifyText>{props.children}</LinkifyText>
			</Tag>
		);
	};
}

// 会话区本地路径可点击（v1）：
// - 行内 code 恰为一个本地绝对路径 → 渲染为可点击链接（mono 样式）；
// - 文本容器（p/li/td/th/h1-6/blockquote）注入 LinkifyText 处理裸路径；
// - <a> 子树由 LinkifyText 内部跳过，不二次链接化
// 注：Streamdown 的 Components 类型带 string 索引签名（Record<string, unknown>），
// 与具体组件参数面在严格 contravariant 下无法同时满足双向检查，组装处统一收窄。
const components = {
	inlineCode(props: JSX.IntrinsicElements["code"] & ExtraProps) {
		const text = inlineText(props.children);
		const path = text === null ? null : toLocalPath(text);
		if (path !== null) {
			return (
				<LocalPathLink path={path} className="font-mono text-[0.85em]">
					{text}
				</LocalPathLink>
			);
		}
		// 非路径：按默认行内 code 渲染（只取 className，剥掉 node 等解析内部 props）
		return <code className={props.className}>{props.children}</code>;
	},
	p: linkified(defaultComponents.p),
	li: linkified(defaultComponents.li),
	td: linkified(defaultComponents.td),
	th: linkified(defaultComponents.th),
	blockquote: linkified(defaultComponents.blockquote),
	h1: linkified(defaultComponents.h1),
	h2: linkified(defaultComponents.h2),
	h3: linkified(defaultComponents.h3),
	h4: linkified(defaultComponents.h4),
	h5: linkified(defaultComponents.h5),
	h6: linkified(defaultComponents.h6),
} as unknown as Components;

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
			components={components}
		>
			{text}
		</Streamdown>
	);
}
