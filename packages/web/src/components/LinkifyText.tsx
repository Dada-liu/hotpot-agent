// 递归遍历 React children，把字符串节点里的本地绝对路径渲染成 LocalPathLink。
// <a>/<code>/<pre> 子树原样跳过（链接与代码内不二次链接化，code 由单独覆写处理）；
// 其余元素 clone 后递归 children。StreamdownMarkdown 的文本容器与用户气泡共用。

import {
	cloneElement,
	Fragment,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { tokenizeLocalPaths } from "@/lib/local-path";
import { LocalPathLink } from "./LocalPathLink.tsx";

// 跳过链接化的子树根：host 的 code/pre（代码内不二次处理）；
// 链接按 href prop 判定——streamdown 的 <a> 是带 href 的 button 组件，不是 "a" 字符串
const SKIP_TAGS = new Set(["code", "pre"]);

export function LinkifyText({
	children,
}: {
	children: ReactNode;
}): ReactElement {
	return <>{linkifyNode(children)}</>;
}

function linkifyNode(node: ReactNode): ReactNode {
	if (typeof node === "string") {
		const tokens = tokenizeLocalPaths(node);
		if (tokens.length === 1 && tokens[0].path === undefined) return node;
		// key 用 文本+出现序号（流式期间文本变化时重挂载本就不可避免）；
		// 不用数组下标，避免同款 token 重复时 key 冲突
		const seen = new Map<string, number>();
		return tokens.map((t) => {
			const id = t.path ?? t.text;
			const n = seen.get(id) ?? 0;
			seen.set(id, n + 1);
			const key = `${id}:${n}`;
			return t.path === undefined ? (
				<Fragment key={key}>{t.text}</Fragment>
			) : (
				<LocalPathLink key={key} path={t.path}>
					{t.text}
				</LocalPathLink>
			);
		});
	}
	if (typeof node === "number" || typeof node === "boolean") return node;
	if (node === null || node === undefined) return node;
	if (Array.isArray(node)) {
		// 元素经 cloneElement 保留原 key，纯字符串节点无需 key
		return node.map((child) => linkifyNode(child));
	}
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode; href?: unknown };
		// 链接子树（含 streamdown 以 button 组件实现的 <a>）不二次链接化
		if (typeof props.href === "string") return node;
		if (typeof node.type === "string" && SKIP_TAGS.has(node.type)) return node;
		if (props.children === undefined) return node;
		return cloneElement(node, undefined, linkifyNode(props.children));
	}
	return node;
}
