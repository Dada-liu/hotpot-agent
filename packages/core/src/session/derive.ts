// deriveMessages：把事件日志转换成 ai 包的 Message[]，供每次 LLM 请求前重建历史
// 规则：
// - user_msg → role:"user"（text 块）
// - assistant_msg → role:"assistant"（content 即 ContentBlock[]）
// - tool_result → role:"user" 消息承载 tool_result 块；连续的 tool_result 合并为一条
//   （Anthropic 要求同一轮的全部 tool_result 放在一条 user 消息里）
// - 其余事件类型（meta/tool_call/approval/* 等）不进消息历史
// - 只转换指定 agentId 的事件；tool_result 按 agentId 过滤，
//   无 agentId 的（M1 旧日志）视为 "main"

import type { ContentBlock, Message } from "@hotpot/ai";
import type { SessionEvent } from "./events.ts";

export function deriveMessages(
	events: SessionEvent[],
	agentId: string,
): Message[] {
	const messages: Message[] = [];
	for (const event of events) {
		if (event.type === "user_msg" && event.agentId === agentId) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: event.content }],
			});
		} else if (event.type === "assistant_msg" && event.agentId === agentId) {
			messages.push({ role: "assistant", content: event.content });
		} else if (
			event.type === "tool_result" &&
			(event.agentId ?? "main") === agentId
		) {
			const block: ContentBlock = {
				type: "tool_result",
				toolCallId: event.toolCallId,
				content: event.content,
				isError: event.isError,
			};
			const last = messages[messages.length - 1];
			if (
				last &&
				last.role === "user" &&
				last.content.every((b) => b.type === "tool_result")
			) {
				last.content.push(block);
			} else {
				messages.push({ role: "user", content: [block] });
			}
		}
	}
	return messages;
}
