// Markdown 子集渲染器：直接产出 React 元素，无 dangerouslySetInnerHTML，
// 文本经 React 转义，天然无 HTML 注入面。
// 支持：#/##/### 标题、``` 围栏代码块、`行内代码`、**粗体**、- 无序列表、段落；
// 其余行原样输出。健壮优先：畸形输入（未闭合围栏/悬垂标记）不抛异常。

import { Fragment, type ReactElement, type ReactNode } from "react";

// 行内格式：`code` 与 **bold**，其余原样文本
const INLINE_RE = /(`[^`]*`|\*\*[^*]*\*\*)/g;

function renderInline(text: string): ReactNode[] {
	const parts = text.split(INLINE_RE);
	let seq = 0;
	return parts.map((part) => {
		// key 由内容与序号共同派生（同一文本出现多次也能区分）
		const key = `${seq++}:${part}`;
		if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
			return <code key={key}>{part.slice(1, -1)}</code>;
		}
		if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
			return <strong key={key}>{part.slice(2, -2)}</strong>;
		}
		return <Fragment key={key}>{part}</Fragment>;
	});
}

export function Markdown({ text }: { text: string }): ReactElement {
	const lines = text.split("\n");
	const blocks: ReactElement[] = [];
	// 未闭合围栏也安全：吞掉剩余全部行
	let inCode = false;
	let codeLines: string[] = [];
	let paraLines: string[] = [];
	let listItems: string[] = [];

	const flushPara = () => {
		if (paraLines.length > 0) {
			const key = blocks.length;
			blocks.push(<p key={key}>{renderInline(paraLines.join(" "))}</p>);
			paraLines = [];
		}
	};
	const flushList = () => {
		if (listItems.length > 0) {
			const key = blocks.length;
			let seq = 0;
			blocks.push(
				<ul key={key}>
					{listItems.map((item) => (
						<li key={`${seq++}:${item}`}>{renderInline(item)}</li>
					))}
				</ul>,
			);
			listItems = [];
		}
	};
	const flushAll = () => {
		flushPara();
		flushList();
	};

	for (const line of lines) {
		if (inCode) {
			if (line.startsWith("```")) {
				const key = blocks.length;
				blocks.push(
					<pre key={key}>
						<code>{codeLines.join("\n")}</code>
					</pre>,
				);
				codeLines = [];
				inCode = false;
			} else {
				codeLines.push(line);
			}
			continue;
		}
		if (line.startsWith("```")) {
			flushAll();
			inCode = true;
			continue;
		}
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		if (heading) {
			flushAll();
			const level = heading[1].length;
			const content = renderInline(heading[2]);
			const key = blocks.length;
			if (level === 1) blocks.push(<h1 key={key}>{content}</h1>);
			else if (level === 2) blocks.push(<h2 key={key}>{content}</h2>);
			else blocks.push(<h3 key={key}>{content}</h3>);
			continue;
		}
		const listItem = /^-\s+(.*)$/.exec(line);
		if (listItem) {
			flushPara();
			listItems.push(listItem[1]);
			continue;
		}
		if (line.trim() === "") {
			flushAll();
			continue;
		}
		flushList();
		paraLines.push(line);
	}
	// 收尾：未闭合围栏把已收集的代码行照样输出
	if (inCode && codeLines.length > 0) {
		const key = blocks.length;
		blocks.push(
			<pre key={key}>
				<code>{codeLines.join("\n")}</code>
			</pre>,
		);
	}
	flushAll();

	return <>{blocks}</>;
}
