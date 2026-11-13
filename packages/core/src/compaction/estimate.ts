import type { Message, ToolDeclaration } from "@hotpot/ai";

// 保守上界：序列化覆盖消息正文、tool 调用、system 与完整工具 schema。
// UTF-8 字节数不低于常见 tokenizer 的 token 数，避免中文/emoji 被字符均摊法低估。
export function estimateTokens(
	messages: Message[],
	system: string,
	tools: ToolDeclaration[],
): number {
	return new TextEncoder().encode(JSON.stringify({ messages, system, tools }))
		.length;
}
