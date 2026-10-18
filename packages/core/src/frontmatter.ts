// 最小 frontmatter 解析（skill 与 prompt template 共用）：
// 首行须为 `---`，取到下一个 `---` 为止（无收尾围栏则读到文件尾，宽容处理）；
// 只收集 `key: value` 行，值取第一个冒号后的全部内容（`description: a: b` 的值是 `a: b`），
// 首尾空白裁掉。不支持嵌套 YAML/列表/多行值——M4 只消费 name/description 两个标量键。

export function parseFrontmatter(text: string): Record<string, string> {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") {
		return {};
	}
	const meta: Record<string, string> = {};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "---") {
			break;
		}
		const sep = line.indexOf(":");
		if (sep <= 0) {
			continue; // 非 key: value 行（空行、列表、注释等）一律忽略
		}
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		if (key !== "") {
			meta[key] = value;
		}
	}
	return meta;
}
