// 错误信息脱敏：任何错误文本离开本机之前都要先过这里。
// 顺序敏感：先替换代码块（内容不可控），再抽出 URL 换成占位符（避免 URL 的 pathname
// 被后面的绝对路径规则误伤），然后替换邮箱、Windows/UNC/绝对 POSIX 路径，
// 还原 URL，压缩空白，最后按长度截断。
// 原则是宁可多删不可漏删：解析失败时丢弃原文返回占位符，绝不把原始内容透传出去。

const DEFAULT_MAX_LENGTH = 500;

// 未闭合的代码块一直吃到文末，避免半截代码泄漏
const CODE_FENCE_PATTERN = /```[\s\S]*?(?:```|$)/g;

// 匹配任意 scheme:// URL；末尾字符排除常见标点，防止把句子里的逗号、句号吞进 URL
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)]/gi;

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// 绝对 POSIX 路径：以 / 开头，前一个字符必须是行首或空白、引号、括号、等号、冒号
const POSIX_PATH_PATTERN = /(^|[\s"'`([={:])\/[^\s"'`<>|]+/g;

// Windows 盘符路径：C:\Users\...
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s"'`<>|]+/g;

// UNC 路径：\\server\share
const UNC_PATH_PATTERN = /\\\\[^\s\\/"'`<>|]+\\[^\s"'`<>|]+/g;

const URL_PLACEHOLDER_PATTERN = /\uE000(\d+)\uE001/g;

export interface SanitizeOptions {
	maxLength?: number;
}

export function sanitizeErrorMessage(
	message: string,
	opts?: SanitizeOptions,
): string {
	// 面向 JS 调用方的兜底：运行时拿到的可能不是字符串
	if (typeof message !== "string") {
		return "";
	}

	try {
		let text = message.replace(CODE_FENCE_PATTERN, " <code> ");

		const urls: string[] = [];
		text = text.replace(URL_PATTERN, (raw) => {
			urls.push(normalizeUrl(raw));
			return `\uE000${urls.length - 1}\uE001`;
		});

		text = text.replace(EMAIL_PATTERN, "<email>");
		text = text.replace(WINDOWS_PATH_PATTERN, "<path>");
		text = text.replace(UNC_PATH_PATTERN, "<path>");
		text = text.replace(
			POSIX_PATH_PATTERN,
			(_match, prefix: string) => `${prefix}<path>`,
		);

		text = text.replace(
			URL_PLACEHOLDER_PATTERN,
			(_match, index: string) => urls[Number(index)] ?? "<url>",
		);

		text = text.replace(/\s+/g, " ").trim();

		return text.slice(0, resolveMaxLength(opts?.maxLength));
	} catch {
		// 兜底：宁可丢掉这条错误信息，也不让未脱敏内容离开本机
		return "";
	}
}

function normalizeUrl(raw: string): string {
	try {
		const url = new URL(raw);
		// file: URL 的 pathname 就是本机绝对路径，不能保留
		if (url.protocol === "file:") {
			return "<path>";
		}
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "<url>";
	}
}

function resolveMaxLength(maxLength: number | undefined): number {
	if (
		typeof maxLength !== "number" ||
		!Number.isFinite(maxLength) ||
		maxLength < 0
	) {
		return DEFAULT_MAX_LENGTH;
	}
	return Math.floor(maxLength);
}
