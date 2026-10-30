// Markdown 入口：React.lazy 把渲染器本体（StreamdownMarkdown.tsx，含 shiki/katex/mermaid 核心）
// 拆成异步 chunk，首屏主包不背这些重量级依赖；首个助手消息出现时并行加载，本地服务下无感知。
// 这是 packages/web 内唯一的动态 import 分割点：AGENTS.md 的"禁 inline import"针对 Node/tsup
// 工具链的静态模块图，本包由 Vite 打包，此处是刻意的代码分割。
// memo：流式打字期间历史消息跳过重渲染，打字机只重绘当前流式段（约定见 STYLE_GUIDE.md 第 5 节）。

import { lazy, memo, type ReactElement, Suspense } from "react";

const StreamdownMarkdown = lazy(() => import("./StreamdownMarkdown.tsx"));

export const Markdown = memo(function Markdown({
	text,
	streaming = false,
}: {
	text: string;
	streaming?: boolean;
}): ReactElement | null {
	if (text.trim() === "") {
		return null;
	}
	return (
		<Suspense fallback={null}>
			<StreamdownMarkdown text={text} streaming={streaming} />
		</Suspense>
	);
});
