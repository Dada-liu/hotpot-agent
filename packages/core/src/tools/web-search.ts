// web_search 工具（M4 Feature ⑥b）：worker/task 的联网搜索，后端可换。
// 后端契约 `WebSearchBackend`：search(query, count, signal) 返回 {title,url,snippet} 列表。
// 两种内置实现：
// - duckduckgo（缺省，无 key）：POST html.duckduckgo.com/html/（form 参数 q），正则解析结果块
//   （.result 内 a.result__a 的 href/title + .result__snippet 文本；href 可能是 /l/?uddg=
//   重定向包装，取 uddg= 参数解码出原始 URL）；结果为空返回空列表（非错误）。不引 DOM 依赖。
// - custom：GET {baseUrl}?q={query}&count={count}，apiKey 存在时以 `Authorization: Bearer`
//   发送，另可带自定义 headers；响应 JSON 形状必须是 {results:[{title,url,snippet}]}，
//   HTTP 非 2xx 或形状不符抛错（由工具层统一 isError 化）。
// settings.webSearch.backend 切换后端（见 config.ts webSearchSchema）；
// `createWebSearchBackendFromConfig` 是配置→后端的唯一解析口，assembly 层（orchestrator
// createRuntime）经它解析，避免映射在多处漂移。fetchImpl 可注入（测试注 fake 保证 hermetic）。
// 超时默认值为模块顶部常量：内部 AbortSignal.timeout 与 ctx.signal 经 AbortSignal.any 组合，
// 任一路都能中断底层 fetch。只读网络资源、无本地副作用，isConcurrencySafe 为 true。

import { z } from "zod";
import type { WebSearchConfig } from "../config/config.ts";
import type { ToolDefinition } from "./tool.ts";

// 默认超时与结果数上限（模块顶部常量，测试直接引用）：30s 超时、默认 5 条、上限 10 条
export const WEB_SEARCH_TIMEOUT_MS = 30_000;
export const WEB_SEARCH_DEFAULT_COUNT = 5;
export const WEB_SEARCH_MAX_COUNT = 10;

// 搜索结果项：title/url/snippet 三要素，两种后端与 custom JSON 形状统一为此结构
export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

// 可换后端契约：search 以 AbortSignal 收中止，抛错即失败（工具层映射 isError）
export interface WebSearchBackend {
	search(
		query: string,
		count: number,
		signal: AbortSignal,
	): Promise<WebSearchResult[]>;
}

type WebSearchArgs = { query: string; count?: number };

// —— DuckDuckGo 后端 ——

const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";

// 结果块切分：class 含单词 result 的 div（\b 边界，不误伤 results_links 等复合类名）
const RESULT_DIV_RE = /<div\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>/g;
// 块内标题锚点：class 含 result__a 的 <a>，属性顺序无关（href 可先可后）
const TITLE_ANCHOR_RE =
	/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/;
// 块内摘要锚点：class 含 result__snippet 的 <a>
const SNIPPET_ANCHOR_RE =
	/<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/;
const HREF_ATTR_RE = /\bhref="([^"]*)"/;

// HTML 实体最小解码：五个常见具名实体 + 十进制/十六进制数字实体，够用且不引依赖
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};

function decodeEntities(text: string): string {
	return text
		.replace(
			/&(amp|lt|gt|quot|apos|nbsp);/g,
			(name) => NAMED_ENTITIES[name.slice(1, -1)] ?? name,
		)
		.replace(/&#(\d+);/g, (_, code: string) =>
			String.fromCodePoint(Number(code)),
		)
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		);
}

// 去其余尖括号标签并压缩空白（snippet/title 内常有 <b> 高亮标签）
function stripTags(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// DuckDuckGo 的 href 常是 /l/?uddg=<url编码>&rut=... 重定向包装：
// 经 URL 解析取 uddg 参数（searchParams 自带百分号解码）还原原始 URL；
// 协议相对链接补 https:；解析失败则原样返回
function unwrapDuckLink(href: string): string {
	const normalized = href.startsWith("//") ? `https:${href}` : href;
	try {
		const parsed = new URL(normalized, DUCKDUCKGO_ENDPOINT);
		const uddg = parsed.searchParams.get("uddg");
		if (uddg !== null && uddg !== "") {
			return uddg;
		}
		return normalized;
	} catch {
		return normalized;
	}
}

// 解析 DuckDuckGo HTML 结果页：按 result div 切块，块内取标题锚点与摘要锚点。
// 结果为空返回空列表（非错误）。纯正则启发式，不保证对全部页面结构成立
function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const starts: number[] = [];
	for (const match of html.matchAll(RESULT_DIV_RE)) {
		starts.push(match.index);
	}
	for (let i = 0; i < starts.length; i++) {
		const block = html.slice(starts[i], starts[i + 1] ?? html.length);
		const titleMatch = TITLE_ANCHOR_RE.exec(block);
		if (!titleMatch) {
			continue;
		}
		const anchorTag = titleMatch[0];
		const inner = titleMatch[1] ?? "";
		const hrefMatch = HREF_ATTR_RE.exec(anchorTag);
		if (!hrefMatch || hrefMatch[1] === undefined) {
			continue;
		}
		const snippetMatch = SNIPPET_ANCHOR_RE.exec(block);
		results.push({
			title: decodeEntities(stripTags(inner)),
			url: unwrapDuckLink(hrefMatch[1]),
			snippet: snippetMatch
				? decodeEntities(stripTags(snippetMatch[1] ?? ""))
				: "",
		});
	}
	return results;
}

export function createDuckDuckGoBackend(deps?: {
	fetchImpl?: typeof fetch;
}): WebSearchBackend {
	const doFetch: typeof fetch = deps?.fetchImpl ?? fetch;
	return {
		async search(
			query: string,
			count: number,
			signal: AbortSignal,
		): Promise<WebSearchResult[]> {
			const response = await doFetch(DUCKDUCKGO_ENDPOINT, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ q: query }),
				signal,
			});
			if (!response.ok) {
				throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
			}
			const html = await response.text();
			return parseDuckDuckGoHtml(html).slice(0, count);
		},
	};
}

// —— custom 后端 ——

// custom 响应形状校验：{ results: [{ title, url, snippet }] }，三项必须都是 string
function isResultItem(item: unknown): item is WebSearchResult {
	if (typeof item !== "object" || item === null) {
		return false;
	}
	const record = item as Record<string, unknown>;
	return (
		typeof record.title === "string" &&
		typeof record.url === "string" &&
		typeof record.snippet === "string"
	);
}

function parseCustomResults(data: unknown): WebSearchResult[] {
	if (
		typeof data !== "object" ||
		data === null ||
		!Array.isArray((data as Record<string, unknown>).results)
	) {
		throw new Error(
			"custom search backend response must be an object with a results array",
		);
	}
	const items: unknown = (data as Record<string, unknown>).results;
	if (!(items as unknown[]).every(isResultItem)) {
		throw new Error(
			"custom search backend results items must be { title, url, snippet } strings",
		);
	}
	return items as WebSearchResult[];
}

export function createCustomBackend(opts: {
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	fetchImpl?: typeof fetch;
}): WebSearchBackend {
	let base: URL;
	try {
		base = new URL(opts.baseUrl);
	} catch {
		throw new Error(`Invalid custom search baseUrl: ${opts.baseUrl}`);
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error(
			`Invalid custom search baseUrl protocol "${base.protocol}": only http:// and https:// are supported`,
		);
	}
	const doFetch: typeof fetch = opts.fetchImpl ?? fetch;
	return {
		async search(
			query: string,
			count: number,
			signal: AbortSignal,
		): Promise<WebSearchResult[]> {
			const url = new URL(base.toString());
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(count));
			// 自定义头先铺，apiKey 的 Authorization 覆盖同名键：凭证优先级最高
			const headers: Record<string, string> = { ...opts.headers };
			if (opts.apiKey !== undefined && opts.apiKey !== "") {
				headers.Authorization = `Bearer ${opts.apiKey}`;
			}
			const response = await doFetch(url.toString(), {
				method: "GET",
				headers,
				signal,
			});
			if (!response.ok) {
				throw new Error(
					`custom search backend returned HTTP ${response.status}`,
				);
			}
			let data: unknown;
			try {
				data = await response.json();
			} catch {
				throw new Error("custom search backend returned invalid JSON");
			}
			return parseCustomResults(data).slice(0, count);
		},
	};
}

// 配置→后端的唯一解析口：缺省或 duckduckgo → DuckDuckGo（无 key）；custom 必须给 baseUrl，
// apiKey/headers 可选。assembly 层（orchestrator createRuntime）经此处装配 runtime.webSearchBackend
export function createWebSearchBackendFromConfig(
	config: WebSearchConfig | undefined,
	deps?: { fetchImpl?: typeof fetch },
): WebSearchBackend {
	if (config === undefined || config.backend === "duckduckgo") {
		return createDuckDuckGoBackend(deps);
	}
	if (config.baseUrl === undefined || config.baseUrl.trim() === "") {
		throw new Error('settings.webSearch: backend "custom" requires a baseUrl');
	}
	return createCustomBackend({
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		headers: config.headers,
		fetchImpl: deps?.fetchImpl,
	});
}

// —— web_search 工具 ——

export function createWebSearchTool(
	backend: WebSearchBackend,
): ToolDefinition<WebSearchArgs> {
	return {
		name: "web_search",
		description:
			"Search the web for a query and return a numbered list of results, each with title, URL and snippet. The number of results is controlled by count (default 5, maximum 10). The search backend is configurable (DuckDuckGo by default).",
		parameters: z.object({
			query: z.string().min(1).describe("the search query"),
			// 声明层钉 min 1 / max 10（JSON Schema 可见），缺省由执行体兜 5；
			// 执行体再钳制一次，兜底直接调用 execute（未经 registry parse）的路径
			count: z
				.number()
				.int()
				.min(1)
				.max(WEB_SEARCH_MAX_COUNT)
				.optional()
				.describe(
					"number of results to return; default 5, values are clamped to at most 10",
				),
		}),
		// 只读网络资源，同批调用可并行
		isConcurrencySafe: true,
		async execute(args, ctx) {
			const count = Math.min(
				WEB_SEARCH_MAX_COUNT,
				Math.max(1, Math.round(args.count ?? WEB_SEARCH_DEFAULT_COUNT)),
			);

			// ctx.signal 与内部超时信号组合：任一路触发都会中断底层 fetch
			const signal = AbortSignal.any([
				ctx.signal,
				AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
			]);

			let results: WebSearchResult[];
			try {
				results = await backend.search(args.query, count, signal);
			} catch (err) {
				// AbortSignal.timeout 触发的是 TimeoutError；ctx.signal 触发的是 AbortError
				if (err instanceof DOMException && err.name === "TimeoutError") {
					return {
						content: `Web search timed out after ${WEB_SEARCH_TIMEOUT_MS} ms`,
						isError: true,
					};
				}
				if (err instanceof DOMException && err.name === "AbortError") {
					return { content: "Web search aborted", isError: true };
				}
				return {
					content: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}

			if (results.length === 0) {
				return { content: `No results found for "${args.query}"` };
			}
			const body = results
				.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
				.join("\n\n");
			return { content: body };
		},
	};
}
