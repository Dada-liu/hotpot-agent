// web_fetch 工具（M4 Feature ⑥a）：worker/task 的网页抓取。
// GET 抓取 http/https URL 并返回文本正文：文本类 Content-Type 才读（text/*、json、xml、
// javascript、svg），HTML 额外做轻量剥离（去 script/style 标签及内容、去其余尖括号标签、
// 压缩空白）；application/pdf、image/* 等非文本类型直接 isError 说明，不把乱码塞进上下文。
// 超时与上限默认值为模块顶部常量：内部 AbortSignal.timeout 与 ctx.signal 经 AbortSignal.any
// 组合，任一路都能中断 fetch；正文按字节上限截断（停止读流），再按 maxChars 截断文本，
// 截断均带标注。只读网络资源、无本地副作用，isConcurrencySafe 为 true。
// fetchImpl 可注入（测试注 fake 保证 hermetic，不触真实网络）。

import { z } from "zod";
import type { ToolDefinition } from "./tool.ts";

// 默认超时与上限（模块顶部常量，测试直接引用）：30s 超时、512KB 字节上限、100000 字符上限
export const WEB_FETCH_TIMEOUT_MS = 30_000;
export const WEB_FETCH_MAX_BYTES = 512 * 1024;
export const WEB_FETCH_MAX_CHARS = 100_000;

type WebFetchArgs = { url: string; maxChars?: number };

// 判断 Content-Type 是否文本类：空类型按 text/plain 宽容处理（与浏览器默认一致）
function isTextualContentType(contentType: string): boolean {
	const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
	if (mime === "") return true;
	return (
		mime.startsWith("text/") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		mime === "application/javascript" ||
		mime === "application/ecmascript"
	);
}

// HTML 轻量剥离：script/style 标签连同内容一起去掉（跨行、非贪婪、大小写不敏感），
// 再去其余尖括号标签，最后压缩空白。不做实体解码与结构还原，避免引入 HTML 解析依赖
function stripHtml(html: string): string {
	return html
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function createWebFetchTool(deps?: {
	fetchImpl?: typeof fetch;
}): ToolDefinition<WebFetchArgs> {
	const doFetch: typeof fetch = deps?.fetchImpl ?? fetch;

	return {
		name: "web_fetch",
		description:
			"Fetch a web page or text resource over HTTP(S) and return its content as text. Only http:// and https:// URLs are supported; the request is always a GET. HTML responses are lightly stripped (script/style blocks and all tags removed, whitespace collapsed); JSON, XML and plain text are returned as-is. Non-text content types (e.g. PDF, images) are rejected. Large responses are truncated at the byte cap and by maxChars, with a truncation notice. Times out after 30 seconds.",
		parameters: z.object({
			url: z.string().min(1).describe("the http:// or https:// URL to fetch"),
			maxChars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"maximum characters of text to return; default 100000. Longer content is truncated with a notice.",
				),
		}),
		// 只读网络资源，同批调用可并行
		isConcurrencySafe: true,
		async execute(args, ctx) {
			let parsed: URL;
			try {
				parsed = new URL(args.url);
			} catch {
				return { content: `Invalid URL: ${args.url}`, isError: true };
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return {
					content: `Unsupported protocol "${parsed.protocol}": only http:// and https:// URLs can be fetched`,
					isError: true,
				};
			}

			// ctx.signal 与内部超时信号组合：任一路触发都会中断 fetch
			const signal = AbortSignal.any([
				ctx.signal,
				AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
			]);

			let response: Response;
			try {
				response = await doFetch(parsed.toString(), { signal });
			} catch (err) {
				// AbortSignal.timeout 触发的是 TimeoutError；ctx.signal 触发的是 AbortError
				if (err instanceof DOMException && err.name === "TimeoutError") {
					return {
						content: `Fetch timed out after ${WEB_FETCH_TIMEOUT_MS} ms: ${args.url}`,
						isError: true,
					};
				}
				if (err instanceof DOMException && err.name === "AbortError") {
					return { content: `Fetch aborted: ${args.url}`, isError: true };
				}
				return {
					content: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			if (!response.ok) {
				const statusText = response.statusText ? ` ${response.statusText}` : "";
				return {
					content: `HTTP ${response.status}${statusText} fetching ${args.url}`,
					isError: true,
				};
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (!isTextualContentType(contentType)) {
				return {
					content: `Unsupported content type "${contentType}" at ${args.url}: only text responses (HTML, JSON, XML, plain text) can be fetched`,
					isError: true,
				};
			}

			// 按字节上限读流：超出即停，不把无限大的响应拉进内存
			const chunks: Uint8Array[] = [];
			let received = 0;
			let byteCapped = false;
			if (response.body !== null) {
				const reader = response.body.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (value === undefined) continue;
						const remaining = WEB_FETCH_MAX_BYTES - received;
						if (value.byteLength >= remaining) {
							if (remaining > 0) chunks.push(value.subarray(0, remaining));
							received = WEB_FETCH_MAX_BYTES;
							byteCapped = true;
							break;
						}
						chunks.push(value);
						received += value.byteLength;
					}
				} finally {
					// 提前 break 时释放底层连接；自然读完时 cancel 是 no-op
					await reader.cancel().catch(() => {});
				}
			}

			const bytes = new Uint8Array(received);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			let text = new TextDecoder("utf-8").decode(bytes);

			const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
			if (mime === "text/html" || mime === "application/xhtml+xml") {
				text = stripHtml(text);
			}

			// 字符级截断在字节截断与 HTML 剥离之后进行（剥离后的文本才计入 maxChars）
			const maxChars = args.maxChars ?? WEB_FETCH_MAX_CHARS;
			let charCapped = false;
			if (text.length > maxChars) {
				text = text.slice(0, maxChars);
				charCapped = true;
			}

			const notices: string[] = [];
			if (byteCapped) {
				notices.push(`body truncated at ${WEB_FETCH_MAX_BYTES} bytes`);
			}
			if (charCapped) {
				notices.push(`text truncated at ${maxChars} characters`);
			}
			const body =
				notices.length > 0
					? `[truncated: ${notices.join("; ")}]\n${text}`
					: text;
			return { content: body };
		},
	};
}
