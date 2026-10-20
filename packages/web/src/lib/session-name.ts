// 从首轮提示词提取会话显示名：取首行、去首尾空白，不做截断——
// 展示侧（会话列表）用 CSS 省略号打点，hover 由 tooltip 展示全称。
// 纯函数，供 App（创建会话时命名）与测试使用。

export function sessionNameFromPrompt(content: string): string {
	const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
	return firstLine === "" ? "新会话" : firstLine;
}
