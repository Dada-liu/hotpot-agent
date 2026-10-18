// 从首轮提示词提取会话显示名：取首行、去首尾空白、超长截断。
// 纯函数，供 App（创建会话时命名）与测试使用。

const MAX_NAME_LENGTH = 26;

export function sessionNameFromPrompt(content: string): string {
	const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
	if (firstLine === "") {
		return "新会话";
	}
	return firstLine.length > MAX_NAME_LENGTH
		? `${firstLine.slice(0, MAX_NAME_LENGTH)}…`
		: firstLine;
}
