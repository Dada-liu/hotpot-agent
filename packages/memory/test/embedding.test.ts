import { describe, expect, it } from "vitest";
import { EmbeddingClient } from "../src/embedding.ts";

interface EmbeddingItem {
	index: number;
	embedding?: number[];
}

function response(items: EmbeddingItem[], status = 200): Response {
	return new Response(
		JSON.stringify({
			object: "list",
			data: items.map((item) => ({ object: "embedding", ...item })),
			model: "embed-v1",
			usage: { prompt_tokens: 2, total_tokens: 2 },
		}),
		{ status, headers: { "content-type": "application/json" } },
	);
}

function clientWith(fetchImpl: typeof fetch): EmbeddingClient {
	return new EmbeddingClient({
		model: "embed-v1",
		baseUrl: "https://embed.example.test/v1/",
		apiKey: "test-key",
		fetchImpl,
	});
}

describe("EmbeddingClient", () => {
	it("按 OpenAI 兼容契约发送批量请求并携带 Authorization", async () => {
		const requests: { url: string; init: RequestInit | undefined }[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			requests.push({ url: String(input), init });
			return response([
				{ index: 0, embedding: [1, 2] },
				{ index: 1, embedding: [3, 4] },
			]);
		};
		const signal = new AbortController().signal;

		const vectors = await clientWith(fetchImpl).embed(
			["alpha", "beta"],
			signal,
		);

		expect(vectors).toEqual([
			[1, 2],
			[3, 4],
		]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://embed.example.test/v1/embeddings");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.signal).toBe(signal);
		expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe(
			"application/json",
		);
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
			"Bearer test-key",
		);
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			model: "embed-v1",
			input: ["alpha", "beta"],
		});
	});

	it("按响应 index 还原文本顺序，而不是采用数组返回顺序", async () => {
		const fetchImpl: typeof fetch = async () =>
			response([
				{ index: 1, embedding: [3, 4] },
				{ index: 0, embedding: [1, 2] },
			]);

		await expect(
			clientWith(fetchImpl).embed(
				["first", "second"],
				new AbortController().signal,
			),
		).resolves.toEqual([
			[1, 2],
			[3, 4],
		]);
	});

	it("HTTP 错误只暴露状态码，不透传可能含原文的响应正文", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("private alpha appeared in an upstream error", {
				status: 401,
			});

		const error = await clientWith(fetchImpl)
			.embed(["private alpha"], new AbortController().signal)
			.then(
				() => null,
				(reason: unknown) => reason,
			);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("401");
		expect((error as Error).message).not.toContain("private alpha");
	});

	it("响应条数与请求不一致时明确报错且不包含原文", async () => {
		const fetchImpl: typeof fetch = async () =>
			response([{ index: 0, embedding: [1, 2] }]);

		const error = await clientWith(fetchImpl)
			.embed(["private alpha", "private beta"], new AbortController().signal)
			.then(
				() => null,
				(reason: unknown) => reason,
			);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/count|条数/i);
		expect((error as Error).message).not.toContain("private alpha");
	});

	it("缺少 embedding 向量时明确报错", async () => {
		const fetchImpl: typeof fetch = async () => response([{ index: 0 }]);

		await expect(
			clientWith(fetchImpl).embed(["alpha"], new AbortController().signal),
		).rejects.toThrow(/embedding|向量/i);
	});

	it("同一批响应维度不一致时明确报错", async () => {
		const fetchImpl: typeof fetch = async () =>
			response([
				{ index: 0, embedding: [1, 2] },
				{ index: 1, embedding: [3] },
			]);

		await expect(
			clientWith(fetchImpl).embed(
				["alpha", "beta"],
				new AbortController().signal,
			),
		).rejects.toThrow(/dimension|维度/i);
	});

	it("把调用方 AbortSignal 传给 fetch 并透传中止", async () => {
		const controller = new AbortController();
		const fetchImpl: typeof fetch = (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});

		const pending = clientWith(fetchImpl).embed(["alpha"], controller.signal);
		const assertion = expect(pending).rejects.toMatchObject({
			name: "AbortError",
		});
		controller.abort();
		await assertion;
	});
});
