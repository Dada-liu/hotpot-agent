import type { Message, ToolDeclaration } from "@hotpot/ai";

// 保守字符估算：序列化覆盖消息正文、tool 调用、system 与完整工具 schema
export function estimateTokens(
	messages: Message[],
	system: string,
	tools: ToolDeclaration[],
): number {
	return Math.ceil(JSON.stringify({ messages, system, tools }).length / 3);
}
