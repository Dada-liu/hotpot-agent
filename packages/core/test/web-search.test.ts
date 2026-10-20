// web_search 工具与两种后端测试：全程注入 fake backend / fetchImpl，不触碰真实网络。
// - 工具层：fake backend 走通声明/执行（编号列表渲染、query/count 透传、count 钳制）、
//   空结果提示（非错误）、后端抛错/TimeoutError/AbortError 的 isError 映射、registry 校验
// - duckduckgo 后端：注入 fetchImpl 回放 HTML 样例（POST form、uddg 重定向解码、
//   实体解码、标签剥离、空结果页、count 截断、非 2xx 抛错）
// - custom 后端：GET 查询串、Authorization Bearer、自定义头合并、JSON 形状映射与拒绝
// - createWebSearchBackendFromConfig：默认/duckduckgo/custom/baseUrl 缺失

import { describe, expect, it } from "vitest";
import { ApprovalChain } from "../src/approval/chain.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/tool.ts";
import {
	createCustomBackend,
	createDuckDuckGoBackend,
	createWebSearchBackendFromConfig,
	createWebSearchTool,
	WEB_SEARCH_DEFAULT_COUNT,
	WEB_SEARCH_MAX_COUNT,
	type WebSearchBackend,
	type WebSearchResult,
} from "../src/tools/web-search.ts";

type CapturedRequest = { url: string; init: RequestInit | undefined };

// 构造注入用的 fetch fake：handler 产响应；requests 回捞实际收到的 url/init
function stubFetch(
	handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetchImpl: typeof fetch = (input, init) => {
		requests.push({ url: String(input), init });
		return handler(String(input), init);
	};
	return { fetchImpl, requests };
}

function makeCtx(signal?: AbortSignal): ToolContext {
	return {
		cwd: "/tmp",
		signal: signal ?? new AbortController().signal,
		approval: new ApprovalChain(),
		agentId: "worker-1",
		session: {
			id: "test-session",
			filePath: "/tmp/test-session.jsonl",
			append: async (_e: SessionEvent) => {},
		},
	};
}

// 记录调用的 fake backend：固定返回 results
function fakeBackend(
	results: WebSearchResult[],
	calls: { query: string; count: number; signal: AbortSignal }[],
): WebSearchBackend {
	return {
		async search(query, count, signal) {
			calls.push({ query, count, signal });
			return results;
		},
	};
}

const TWO_RESULTS: WebSearchResult[] = [
	{ title: "Alpha", url: "https://a.example.com/", snippet: "snippet a" },
	{ title: "Beta", url: "https://b.example.com/", snippet: "snippet b" },
];

describe("createWebSearchTool 声明与执行", () => {
	it("声明：name/description 来自定义，count 默认 5 上限 10 进 JSON Schema", () => {
		const registry = createToolRegistry();
		registry.register(createWebSearchTool(fakeBackend([], [])));
		const decl = registry.declarations()[0];

		expect(decl?.name).toBe("web_search");
		expect(decl?.description).toContain("Search the web");
		const schema = decl?.parameters as {
			type: string;
			properties: Record<
				string,
				{ type: string; default?: number; minimum?: number; maximum?: number }
			>;
			required: string[];
		};
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["query"]);
		expect(schema.properties.query?.type).toBe("string");
		expect(schema.properties.count?.type).toBe("integer");
		expect(schema.properties.count?.minimum).toBe(1);
		expect(schema.properties.count?.maximum).toBe(WEB_SEARCH_MAX_COUNT);
	});

	it("执行：query/count 透传 backend，count 默认 5，结果渲染编号列表", async () => {
		const calls: { query: string; count: number; signal: AbortSignal }[] = [];
		const tool = createWebSearchTool(fakeBackend(TWO_RESULTS, calls));

		const out = await tool.execute({ query: "hotpot" }, makeCtx());

		expect(out.isError ?? false).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.query).toBe("hotpot");
		expect(calls[0]?.count).toBe(WEB_SEARCH_DEFAULT_COUNT);
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(out.content).toBe(
			"1. Alpha\nhttps://a.example.com/\nsnippet a\n\n" +
				"2. Beta\nhttps://b.example.com/\nsnippet b",
		);
	});

	it("count 钳制：直接调用路径 0→1、99→10、默认→5（不经 registry parse 的兜底）", async () => {
		const calls: { query: string; count: number; signal: AbortSignal }[] = [];
		const tool = createWebSearchTool(fakeBackend([], calls));

		await tool.execute({ query: "q", count: 0 }, makeCtx());
		expect(calls[0]?.count).toBe(1);
		await tool.execute({ query: "q", count: 99 }, makeCtx());
		expect(calls[1]?.count).toBe(WEB_SEARCH_MAX_COUNT);
		await tool.execute({ query: "q" }, makeCtx());
		expect(calls[2]?.count).toBe(WEB_SEARCH_DEFAULT_COUNT);
	});

	it("空结果返回提示文本而非错误", async () => {
		const tool = createWebSearchTool(fakeBackend([], []));

		const out = await tool.execute({ query: "nothing-matches" }, makeCtx());

		expect(out.isError ?? false).toBe(false);
		expect(out.content).toBe('No results found for "nothing-matches"');
	});
});

describe("createWebSearchTool 失败映射", () => {
	it("backend 抛普通 Error → isError 且含原始信息", async () => {
		const backend: WebSearchBackend = {
			async search() {
				throw new Error("backend boom");
			},
		};
		const tool = createWebSearchTool(backend);

		const out = await tool.execute({ query: "q" }, makeCtx());

		expect(out.isError).toBe(true);
		expect(out.content).toContain("Web search failed: backend boom");
	});

	it("backend 抛 TimeoutError → isError 且提示 timed out", async () => {
		const backend: WebSearchBackend = {
			async search() {
				throw new DOMException("timed out", "TimeoutError");
			},
		};
		const tool = createWebSearchTool(backend);

		const out = await tool.execute({ query: "q" }, makeCtx());

		expect(out.isError).toBe(true);
		expect(out.content).toContain("timed out");
	});

	it("backend 抛 AbortError → isError 且提示 aborted", async () => {
		const backend: WebSearchBackend = {
			async search() {
				throw new DOMException("aborted", "AbortError");
			},
		};
		const tool = createWebSearchTool(backend);

		const out = await tool.execute({ query: "q" }, makeCtx());

		expect(out.isError).toBe(true);
		expect(out.content).toContain("aborted");
	});
});

describe("createWebSearchTool registry 层校验", () => {
	it("query 为空 / count 非整数或越界时拒绝执行且不调用 backend", async () => {
		const calls: { query: string; count: number; signal: AbortSignal }[] = [];
		const registry = createToolRegistry();
		registry.register(createWebSearchTool(fakeBackend([], calls)));
		const erased = registry.get("web_search");
		const ctx = makeCtx();

		await expect(erased?.execute({ query: "" }, ctx)).rejects.toThrow();
		await expect(
			erased?.execute({ query: "q", count: 1.5 }, ctx),
		).rejects.toThrow();
		// 声明层 min/max 生效：越界拒绝（钳制只兜底直接调用路径）
		await expect(
			erased?.execute({ query: "q", count: 0 }, ctx),
		).rejects.toThrow();
		await expect(
			erased?.execute({ query: "q", count: WEB_SEARCH_MAX_COUNT + 1 }, ctx),
		).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});

// DuckDuckGo HTML 样例：两条结果——直连 href 与 /l/?uddg= 重定向包装各一，
// 摘要带 <b> 高亮标签与实体，标题含 &amp;
const DDG_HTML_PAGE = [
	'<!DOCTYPE html><html><head><link rel="canonical" href="https://html.duckduckgo.com/html/"></head>',
	'<body><div id="links" class="results">',
	'<div class="result results_links results_links_deep web-result">',
	'  <div class="links_main links_deep result__body">',
	'    <h2 class="result__title">',
	'      <a rel="nofollow" class="result__a" href="https://example.com/first">First &amp; Foremost</a>',
	"    </h2>",
	'    <a rel="nofollow" class="result__snippet" href="https://example.com/first">',
	"      The <b>first</b> result snippet.",
	"    </a>",
	"  </div>",
	"</div>",
	'<div class="result results_links results_links_deep web-result">',
	'  <div class="links_main links_deep result__body">',
	'    <h2 class="result__title">',
	'      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.org%2Fdeep%2Fpage%3Fx%3D1&amp;rut=abc123">Second Result</a>',
	"    </h2>",
	'    <a rel="nofollow" class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.org%2Fdeep%2Fpage%3Fx%3D1&amp;rut=abc123">Second <b>snippet</b> &quot;quoted&quot;</a>',
	"  </div>",
	"</div>",
	"</div></body></html>",
].join("\n");

describe("createDuckDuckGoBackend", () => {
	it("POST html 端点：form 参数 q、urlencoded 头、结果解析与 uddg 解码", async () => {
		const { fetchImpl, requests } = stubFetch(
			async () =>
				new Response(DDG_HTML_PAGE, {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);
		const backend = createDuckDuckGoBackend({ fetchImpl });

		const results = await backend.search(
			"hotpot code",
			10,
			new AbortController().signal,
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://html.duckduckgo.com/html/");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(String(requests[0]?.init?.body)).toBe("q=hotpot+code");
		const headers = requests[0]?.init?.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");

		expect(results).toEqual([
			{
				title: "First & Foremost",
				url: "https://example.com/first",
				snippet: "The first result snippet.",
			},
			{
				title: "Second Result",
				url: "https://real.example.org/deep/page?x=1",
				snippet: 'Second snippet "quoted"',
			},
		]);
	});

	it("count 截断：count=1 只取第一条", async () => {
		const { fetchImpl } = stubFetch(
			async () => new Response(DDG_HTML_PAGE, { status: 200 }),
		);
		const backend = createDuckDuckGoBackend({ fetchImpl });

		const results = await backend.search("q", 1, new AbortController().signal);

		expect(results).toHaveLength(1);
		expect(results[0]?.title).toBe("First & Foremost");
	});

	it("结果为空返回空列表（非错误）", async () => {
		const emptyPage =
			'<html><body><div class="results">no hits here</div></body></html>';
		const { fetchImpl } = stubFetch(
			async () => new Response(emptyPage, { status: 200 }),
		);
		const backend = createDuckDuckGoBackend({ fetchImpl });

		const results = await backend.search("q", 5, new AbortController().signal);

		expect(results).toEqual([]);
	});

	it("非 2xx 状态码：抛错且不含正文", async () => {
		const { fetchImpl } = stubFetch(
			async () => new Response("blocked", { status: 403 }),
		);
		const backend = createDuckDuckGoBackend({ fetchImpl });

		await expect(
			backend.search("q", 5, new AbortController().signal),
		).rejects.toThrow(/HTTP 403/);
	});

	it("网络层失败原样抛出（AbortError），由工具层映射 isError", async () => {
		const { fetchImpl } = stubFetch(async () => {
			throw new DOMException("aborted", "AbortError");
		});
		const backend = createDuckDuckGoBackend({ fetchImpl });

		await expect(
			backend.search("q", 5, new AbortController().signal),
		).rejects.toThrow(/aborted/);
	});
});

describe("createCustomBackend", () => {
	it("GET {baseUrl}?q=&count=：apiKey 走 Authorization Bearer，自定义头合并", async () => {
		const { fetchImpl, requests } = stubFetch(async () =>
			Response.json({
				results: [
					{
						title: "T",
						url: "https://t.example.com/",
						snippet: "s",
					},
				],
			}),
		);
		const backend = createCustomBackend({
			baseUrl: "https://search.example.com/api",
			apiKey: "sk-123",
			headers: { "x-tenant": "acme" },
			fetchImpl,
		});

		const results = await backend.search(
			"hot pot",
			3,
			new AbortController().signal,
		);

		expect(results).toEqual([
			{ title: "T", url: "https://t.example.com/", snippet: "s" },
		]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://search.example.com/api?q=hot+pot&count=3",
		);
		expect(requests[0]?.init?.method).toBe("GET");
		const headers = requests[0]?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-123");
		expect(headers["x-tenant"]).toBe("acme");
	});

	it("无 apiKey 时不发 Authorization 头", async () => {
		const { fetchImpl, requests } = stubFetch(async () =>
			Response.json({ results: [] }),
		);
		const backend = createCustomBackend({
			baseUrl: "https://search.example.com/api",
			fetchImpl,
		});

		await backend.search("q", 5, new AbortController().signal);

		const headers = requests[0]?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("非 2xx / 非法 JSON / 形状不符均抛错", async () => {
		const badStatus = createCustomBackend({
			baseUrl: "https://search.example.com/api",
			fetchImpl: async () => new Response("oops", { status: 500 }),
		});
		await expect(
			badStatus.search("q", 5, new AbortController().signal),
		).rejects.toThrow(/HTTP 500/);

		const badJson = createCustomBackend({
			baseUrl: "https://search.example.com/api",
			fetchImpl: async () =>
				new Response("<html>not json</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		});
		await expect(
			badJson.search("q", 5, new AbortController().signal),
		).rejects.toThrow(/invalid JSON/);

		const badShape = createCustomBackend({
			baseUrl: "https://search.example.com/api",
			fetchImpl: async () => Response.json({ hits: [{ title: "T" }] }),
		});
		await expect(
			badShape.search("q", 5, new AbortController().signal),
		).rejects.toThrow(/results/);

		const badItem = createCustomBackend({
			baseUrl: "https://search.example.com/api",
			fetchImpl: async () =>
				Response.json({
					results: [{ title: 42, url: "u", snippet: "s" }],
				}),
		});
		await expect(
			badItem.search("q", 5, new AbortController().signal),
		).rejects.toThrow(/title, url, snippet/);
	});

	it("baseUrl 非法或非 http/https 协议：构造时即抛错", () => {
		expect(() => createCustomBackend({ baseUrl: "not a url" })).toThrow(
			/Invalid custom search baseUrl/,
		);
		expect(() =>
			createCustomBackend({ baseUrl: "ftp://search.example.com/api" }),
		).toThrow(/protocol/);
	});
});

describe("createWebSearchBackendFromConfig", () => {
	it("config 默认或 duckduckgo → DuckDuckGo 后端（POST html 端点可证）", async () => {
		for (const config of [undefined, { backend: "duckduckgo" }] as const) {
			const { fetchImpl, requests } = stubFetch(
				async () => new Response(DDG_HTML_PAGE, { status: 200 }),
			);
			const backend = createWebSearchBackendFromConfig(config, {
				fetchImpl,
			});
			const results = await backend.search(
				"q",
				5,
				new AbortController().signal,
			);
			expect(requests[0]?.url).toBe("https://html.duckduckgo.com/html/");
			expect(results.length).toBeGreaterThan(0);
		}
	});

	it("custom 配置 → custom 后端（命中 baseUrl）；baseUrl 缺失抛配置错误", async () => {
		const { fetchImpl, requests } = stubFetch(async () =>
			Response.json({ results: [] }),
		);
		const backend = createWebSearchBackendFromConfig(
			{
				backend: "custom",
				baseUrl: "https://search.example.com/api",
				apiKey: "sk-123",
			},
			{ fetchImpl },
		);
		await backend.search("q", 5, new AbortController().signal);
		expect(requests[0]?.url).toContain("https://search.example.com/api?q=q");

		expect(() =>
			createWebSearchBackendFromConfig({ backend: "custom" }),
		).toThrow(/requires a baseUrl/);
	});
});
