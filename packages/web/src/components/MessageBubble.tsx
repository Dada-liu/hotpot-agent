// 消息气泡：user / assistant / streaming 三态。
// assistant 只渲染文本块（tool_call 块由独立的 ToolCallCard 呈现），Markdown 渲染。

import type { ReactElement } from "react";
import { Markdown } from "./Markdown.tsx";

interface MessageBubbleProps {
	variant: "user" | "assistant" | "streaming";
	text: string;
}

export function MessageBubble({
	variant,
	text,
}: MessageBubbleProps): ReactElement | null {
	if (variant === "user") {
		return <div className="bubble bubble-user">{text}</div>;
	}
	if (text.trim() === "") {
		// 纯工具调用的助手消息没有文本，气泡整体不渲染（工具卡片独立呈现）
		return null;
	}
	return (
		<div
			className={
				variant === "streaming"
					? "bubble bubble-streaming"
					: "bubble bubble-assistant"
			}
		>
			<Markdown text={text} />
		</div>
	);
}
