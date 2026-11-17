// 会话显示名规则：取首条用户消息的首行；≤20 字符全取，更长时优先按第一个句子分隔符
// （中英文逗号/句号/分号/冒号/问号/叹号/顿号/换行）截断取前半段，仍超长再截到 20；
// 首行为空（例如只发了附件）回退「新会话」。
// 该规则曾经只存在于 web（localStorage 里按会话 id 存显示名），换 host 或端口即全部丢失、
// 侧栏退化成 cwd；现在由服务端从会话日志派生，随 SessionSummary 返回。
// web 侧仍保留同规则的一份实现，仅用于「刚创建、首条消息尚未落盘」时的乐观显示。

import type { SessionEvent } from "./events.ts";

const MAX_NAME_LENGTH = 20;
const SENTENCE_SEPARATOR = /[，。、；：？！,.;:?!\n]/u;

export function sessionNameFromPrompt(content: string): string {
	const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
	if (firstLine === "") {
		return "新会话";
	}
	if (firstLine.length <= MAX_NAME_LENGTH) {
		return firstLine;
	}
	const idx = firstLine.search(SENTENCE_SEPARATOR);
	if (idx > 0) {
		const cut = firstLine.slice(0, idx).trim();
		if (cut !== "") {
			return cut.length > MAX_NAME_LENGTH ? cut.slice(0, MAX_NAME_LENGTH) : cut;
		}
	}
	return firstLine.slice(0, MAX_NAME_LENGTH);
}

// 从会话事件流取显示名：没有 user_msg（刚创建、或只有内部延续提示）返回 undefined，
// 由客户端决定回退（web 用 cwd）
export function sessionNameFromEvents(
	events: readonly SessionEvent[],
): string | undefined {
	const firstUserMessage = events.find((event) => event.type === "user_msg");
	return firstUserMessage === undefined
		? undefined
		: sessionNameFromPrompt(firstUserMessage.content);
}
