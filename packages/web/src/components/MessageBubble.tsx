// 消息呈现：user 黑底气泡靠右；assistant 裸排版文章流（Kimi 风）；streaming 带橙色光标。
// assistant 只渲染文本块（tool_call 块由独立的 ToolCallCard 呈现），Markdown 渲染。

import { memo, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown.tsx";

interface MessageBubbleProps {
	variant: "user" | "assistant" | "streaming";
	text: string;
}

// memo：打字机流式期间历史气泡跳过重渲染（配合 Markdown 的 memo）
export const MessageBubble = memo(function MessageBubble({
	variant,
	text,
}: MessageBubbleProps): ReactElement | null {
	if (variant === "user") {
		return (
			<div className="ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground">
				{text}
			</div>
		);
	}
	if (text.trim() === "") {
		// 纯工具调用的助手消息没有文本，整体不渲染（工具卡片独立呈现）
		return null;
	}
	return (
		<div className={cn("md", variant === "streaming" && "md-streaming")}>
			<Markdown text={text} />
		</div>
	);
});
