// 会话区本地路径识别与预览分派的纯函数工具（node 可单测）。
// 识别 Unix 绝对路径（macOS 环境）；Windows 路径不在 v1 范围。
// 扩展名白名单需与服务端 packages/server/src/session-manager.ts 的
// VIEWER_TEXT_EXTS / VIEWER_IMAGE_TYPES 保持一致。

// 段字符：ASCII 词字符 + 常见符号，或 CJK（汉字/假名/全角字母数字；
// 刻意排除 CJK 标点 3000-303F 与全角符号 FF00-FF0F 等，防「路径）。」这类吞标点）。
// 不含空白与引号/括号/尖括号/竖线（保守，防 prose 大范围误吞）
const SEG =
	"(?:[\\w.@~+-]|[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff10-\\uff19\\uff21-\\uff3a\\uff41-\\uff5a])+";
// 前置字符不能是 : / 词字符 . @ ~ + -（排除 URL 协议、URL 路径段、版本号等场景）；
// 空白/中文标点/行首前置放行。整串另需至少一个 ASCII 字符（CJK 纯段不命中，
// 如「是/否/不确定」这类中文顿号式 slash 短语）
const LOCAL_PATH_PATTERN = `(?<![:A-Za-z0-9_./@~+-])/(?:${SEG}/)+${SEG}`;
const LOCAL_PATH_RE = new RegExp(LOCAL_PATH_PATTERN, "g");
const LOCAL_PATH_FULL_RE = new RegExp(`^${LOCAL_PATH_PATTERN}$`);
const ASCII_IN_PATH = /[\w.@~+-]/;

// 尾部标点/引号/括号/斜杠不属于路径（句读、markdown 括号收尾等场景）
const TRAILING_JUNK_RE = /[.,;:!?)\]}>'"`/\\]+$/;

export interface LocalPathToken {
	// 原文片段：path 为 undefined 时是普通文本，否则是清洗后的绝对路径
	text: string;
	path?: string;
}

// 把一段纯文本切成 文本/路径 token 序列；无路径时原样返回（调用方快速路径）
export function tokenizeLocalPaths(text: string): LocalPathToken[] {
	const tokens: LocalPathToken[] = [];
	let last = 0;
	for (const m of text.matchAll(LOCAL_PATH_RE)) {
		const cleaned = m[0].replace(TRAILING_JUNK_RE, "");
		// CJK 纯段（无 ASCII 字符）不认定路径：原文本随 surrounding text 保留
		if (cleaned === "" || !ASCII_IN_PATH.test(cleaned)) continue;
		if (m.index > last) tokens.push({ text: text.slice(last, m.index) });
		tokens.push({ text: cleaned, path: cleaned });
		last = m.index + cleaned.length;
	}
	if (tokens.length === 0) return [{ text }];
	if (last < text.length) tokens.push({ text: text.slice(last) });
	return tokens;
}

// 整串是否恰为一个本地路径（行内 code 判型用）：清洗后全串匹配 + 含 ASCII 字符
export function toLocalPath(text: string): string | null {
	const cleaned = text.replace(TRAILING_JUNK_RE, "");
	if (cleaned === "" || !ASCII_IN_PATH.test(cleaned)) return null;
	return LOCAL_PATH_FULL_RE.test(cleaned) ? cleaned : null;
}

// 预览文本扩展名白名单（需求明列 md/ts/python，其余为常见代码/配置/日志格式）
const TEXT_EXTS = new Set([
	"md",
	"mdx",
	"txt",
	"json",
	"js",
	"jsx",
	"ts",
	"tsx",
	"py",
	"css",
	"html",
	"yml",
	"yaml",
	"toml",
	"xml",
	"sh",
	"log",
	"csv",
]);

// 预览图片扩展名（自媒体常见格式 + svg/avif/bmp/ico）
const IMAGE_EXTS = new Set([
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"svg",
	"avif",
	"bmp",
	"ico",
]);

function extOf(name: string): string {
	const i = name.lastIndexOf(".");
	return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function isTextFileName(name: string): boolean {
	return TEXT_EXTS.has(extOf(name));
}

export function isImageFileName(name: string): boolean {
	return IMAGE_EXTS.has(extOf(name));
}

// 路径末段文件名（tab 标题、面包屑用）；兼容末尾带斜杠的目录路径
export function baseName(path: string): string {
	const cleaned = path.replace(/[\\/]+$/, "");
	const i = cleaned.lastIndexOf("/");
	return i === -1 ? cleaned : cleaned.slice(i + 1);
}
