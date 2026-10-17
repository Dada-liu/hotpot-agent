// 工具调用卡片：名称 + 入参摘要（JSON 截断 200 字符）+ 输出可展开 + isError 红标。

import { type ReactElement, useState } from "react";

function summarize(input: unknown): string {
	if (input === undefined) {
		return "";
	}
	let text: string;
	try {
		text = JSON.stringify(input) ?? "";
	} catch {
		return String(input);
	}
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

interface ToolCallCardProps {
	name: string;
	input: unknown;
	result?: { content: string; isError: boolean };
}

export function ToolCallCard({
	name,
	input,
	result,
}: ToolCallCardProps): ReactElement {
	const [expanded, setExpanded] = useState(false);
	const summary = summarize(input);
	return (
		<div
			className={
				result?.isError === true ? "tool-card tool-card-error" : "tool-card"
			}
		>
			<div className="tool-card-head">
				<span className="tool-card-name">{name}</span>
				{result !== undefined && (
					<span
						className={result.isError ? "badge badge-error" : "badge badge-ok"}
					>
						{result.isError ? "error" : "done"}
					</span>
				)}
			</div>
			{summary !== "" && <pre className="tool-card-input">{summary}</pre>}
			{result !== undefined && (
				<div className="tool-card-result">
					<button
						type="button"
						className="btn btn-link"
						onClick={() => {
							setExpanded((v) => !v);
						}}
					>
						{expanded ? "收起输出" : "展开输出"}
					</button>
					{expanded && <pre className="tool-card-output">{result.content}</pre>}
				</div>
			)}
		</div>
	);
}
