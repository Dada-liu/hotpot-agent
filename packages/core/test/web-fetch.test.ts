// web_fetch 工具测试：全程注入 fetchImpl fake，不触碰真实网络。
// - 成功：GET 请求、JSON 原样返回、HTML 轻量剥离（script/style 及内容、其余标签、空白压缩）
// - 拒绝：非法 URL 与非 http/https 协议（ftp:、javascript:）不发起请求；
//   非文本 Content-Type（application/pdf、image/png）返回 isError 说明
// - 失败映射：非 2xx 状态码、TimeoutError、ctx.signal 中止，均 isError
// - 截断：512KB 字节上限（放大 maxChars 隔离验证）与 maxChars 字符上限，均带标注
// - registry 层 schema 校验：url 为空 / maxChars 非正整数被拒绝且不发起请求

import { describe, expect, it } from "vitest";
import { ApprovalChain } from "../src/approval/chain.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/tool.ts";
import {
	createWebFetchTool,
	WEB_FETCH_MAX_BYTES,
} from "../src/tools/web-fetch.ts";

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

const HTML_DOC = [
	"<html><head>",
	"<style>body { color: red; }</style>",
	"<script>alert('x');</script>",
	"</head><body>",
	"  <h1>Hello</h1>",
	'  <p>  world\n  <a href="/x">link</a></p>',
	"</body></html>",
].join("\n");

describe("createWebFetchTool 成功路径", () => {
	it("JSON 响应原样返回，发起 GET 且 URL 一致", async () => {
		const { fetchImpl, requests } = stubFetch(async () =>
			Response.json({ answer: 42 }),
		);
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute(
			{ url: "https://api.example.com/data" },
			makeCtx(),
		);

		expect(out.isError ?? false).toBe(false);
		expect(out.content).toContain('"answer":42');
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.example.com/data");
		expect(requests[0]?.init?.method).toBeUndefined();
		// 工具内部超时信号已注入（与 ctx.signal 组合）
		expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("HTML 响应轻量剥离：script/style 及内容、其余标签去除，空白压缩", async () => {
		const { fetchImpl, requests } = stubFetch(
			async () =>
				new Response(HTML_DOC, {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute(
			{ url: "https://a.example.com/" },
			makeCtx(),
		);

		expect(out.isError ?? false).toBe(false);
		expect(out.content).not.toContain("<script");
		expect(out.content).not.toContain("<style");
		expect(out.content).not.toContain("alert");
		expect(out.content).not.toContain("color");
		expect(out.content).not.toContain("<");
		expect(out.content).toBe("Hello world link");
		expect(requests).toHaveLength(1);
	});

	it("text/plain 无 HTML 剥离，原样返回", async () => {
		const { fetchImpl } = stubFetch(
			async () =>
				new Response("plain  text\n\nkept <as-is>", {
					headers: { "content-type": "text/plain" },
				}),
		);
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute(
			{ url: "https://a.example.com/t.txt" },
			makeCtx(),
		);

		expect(out.content).toBe("plain  text\n\nkept <as-is>");
	});
});

describe("createWebFetchTool 协议与内容类型拒绝", () => {
	it("ftp: 与 javascript: 协议拒绝：isError、说明仅支持 http/https、不发起请求", async () => {
		const { fetchImpl, requests } = stubFetch(async () => {
			throw new Error("should not be called");
		});
		const tool = createWebFetchTool({ fetchImpl });

		for (const url of ["ftp://example.com/a.txt", "javascript:alert(1)"]) {
			const out = await tool.execute({ url }, makeCtx());
			expect(out.isError).toBe(true);
			expect(out.content).toContain("only http:// and https://");
		}
		expect(requests).toHaveLength(0);
	});

	it("非法 URL 拒绝：isError，不发起请求", async () => {
		const { fetchImpl, requests } = stubFetch(async () => {
			throw new Error("should not be called");
		});
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute({ url: "not a url" }, makeCtx());

		expect(out.isError).toBe(true);
		expect(out.content).toContain("Invalid URL");
		expect(requests).toHaveLength(0);
	});

	it("非文本 Content-Type（application/pdf、image/png）拒绝并说明", async () => {
		for (const contentType of ["application/pdf", "image/png"]) {
			const { fetchImpl } = stubFetch(
				async () =>
					new Response("binary-bytes", {
						status: 200,
						headers: { "content-type": contentType },
					}),
			);
			const tool = createWebFetchTool({ fetchImpl });

			const out = await tool.execute(
				{ url: "https://a.example.com/doc" },
				makeCtx(),
			);

			expect(out.isError).toBe(true);
			expect(out.content).toContain(contentType);
			expect(out.content).toContain("only text responses");
		}
	});
});

describe("createWebFetchTool 失败映射", () => {
	it("非 2xx 状态码：isError 且 content 含状态码，不返回正文", async () => {
		const { fetchImpl } = stubFetch(
			async () =>
				new Response("not found body", {
					status: 404,
					statusText: "Not Found",
				}),
		);
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute(
			{ url: "https://a.example.com/missing" },
			makeCtx(),
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("404");
		expect(out.content).not.toContain("not found body");
	});

	it("超时：fetch 以 TimeoutError 拒绝 → isError 且提示 timed out", async () => {
		const { fetchImpl } = stubFetch(async () => {
			throw new DOMException("timed out", "TimeoutError");
		});
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute(
			{ url: "https://slow.example.com/" },
			makeCtx(),
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("timed out");
	});

	it("ctx.signal 中止：组合信号触发 abort → isError 且提示 aborted", async () => {
		// fake 监听工具注入的 signal（AbortSignal.any 组合产物），abort 时以 reason 拒绝
		const { fetchImpl } = stubFetch(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!(signal instanceof AbortSignal)) {
						reject(new Error("signal not injected"));
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							reject(signal.reason);
						},
						{ once: true },
					);
				}),
		);
		const tool = createWebFetchTool({ fetchImpl });
		const controller = new AbortController();

		const start = Date.now();
		const promise = tool.execute(
			{ url: "https://slow.example.com/" },
			makeCtx(controller.signal),
		);
		setTimeout(() => {
			controller.abort();
		}, 20);
		const out = await promise;

		expect(Date.now() - start).toBeLessThan(3_000);
		expect(out.isError).toBe(true);
		expect(out.content).toContain("aborted");
	});
});

describe("createWebFetchTool 截断", () => {
	it("字节上限：512KB 处截断并标注（放大 maxChars 隔离字节层）", async () => {
		const body = "x".repeat(WEB_FETCH_MAX_BYTES + 1000);
		const { fetchImpl } = stubFetch(
			async () =>
				new Response(body, {
					headers: { "content-type": "text/plain" },
				}),
		);
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute(
			{ url: "https://a.example.com/big", maxChars: WEB_FETCH_MAX_BYTES + 10 },
			makeCtx(),
		);

		expect(out.isError ?? false).toBe(false);
		// 用整串相等断言精确截断点（/x{524289}/ 之类否定量词回溯是平方级，不可用）
		const notice = `[truncated: body truncated at ${WEB_FETCH_MAX_BYTES} bytes]\n`;
		expect(out.content).toBe(`${notice}${"x".repeat(WEB_FETCH_MAX_BYTES)}`);
	});

	it("maxChars 上限：文本截断到指定字符数并标注", async () => {
		const { fetchImpl } = stubFetch(
			async () =>
				new Response("abcdefghijklmnopqrstuvwxyz", {
					headers: { "content-type": "text/plain" },
				}),
		);
		const tool = createWebFetchTool({ fetchImpl });

		const out = await tool.execute(
			{ url: "https://a.example.com/abc", maxChars: 5 },
			makeCtx(),
		);

		expect(out.isError ?? false).toBe(false);
		expect(out.content).toContain("[truncated:");
		expect(out.content).toContain("5 characters");
		expect(out.content).toContain("abcde");
		expect(out.content).not.toContain("fghij");
	});
});

describe("createWebFetchTool registry 层校验", () => {
	it("url 为空 / maxChars 非正整数时拒绝执行且不发起请求", async () => {
		const { fetchImpl, requests } = stubFetch(async () => {
			throw new Error("should not be called");
		});
		const registry = createToolRegistry();
		registry.register(createWebFetchTool({ fetchImpl }));
		const erased = registry.get("web_fetch");
		const ctx = makeCtx();

		await expect(erased?.execute({ url: "" }, ctx)).rejects.toThrow();
		await expect(
			erased?.execute({ url: "https://a.example.com/", maxChars: 0 }, ctx),
		).rejects.toThrow();
		await expect(
			erased?.execute({ url: "https://a.example.com/", maxChars: 1.5 }, ctx),
		).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});
});
