import type { EmbeddingConfig } from "./types.ts";

export interface EmbeddingClientOptions extends EmbeddingConfig {
	fetchImpl?: typeof fetch;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// OpenAI 兼容 embeddings 客户端；错误只携带协议信息，不带请求文本或响应正文
export class EmbeddingClient {
	private readonly config: EmbeddingConfig;
	private readonly fetchImpl: typeof fetch;

	constructor(options: EmbeddingClientOptions) {
		this.config = {
			model: options.model,
			baseUrl: options.baseUrl,
			apiKey: options.apiKey,
		};
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
		signal.throwIfAborted();
		if (texts.length === 0) {
			return [];
		}
		// 未配 apiKey（本地服务）时不带 Authorization，避免发出 `Bearer ` 这种空凭证头
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (this.config.apiKey !== undefined && this.config.apiKey !== "") {
			headers.authorization = `Bearer ${this.config.apiKey}`;
		}
		const response = await this.fetchImpl(
			`${this.config.baseUrl.replace(/\/+$/, "")}/embeddings`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ model: this.config.model, input: texts }),
				signal,
			},
		);
		if (!response.ok) {
			throw new Error(`embedding request failed with HTTP ${response.status}`);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error("embedding response is not valid JSON");
		}
		if (!isObject(payload) || !Array.isArray(payload.data)) {
			throw new Error("embedding response is missing data");
		}
		if (payload.data.length !== texts.length) {
			throw new Error(
				`embedding response count mismatch: expected ${texts.length}, received ${payload.data.length}`,
			);
		}

		const vectors: number[][] = new Array(texts.length);
		const seen = new Set<number>();
		let dimensions: number | undefined;
		for (const item of payload.data) {
			if (!isObject(item) || !Number.isInteger(item.index)) {
				throw new Error("embedding response contains an invalid index");
			}
			const index = item.index as number;
			if (index < 0 || index >= texts.length || seen.has(index)) {
				throw new Error("embedding response contains an invalid index");
			}
			seen.add(index);
			const embedding = item.embedding;
			if (
				!Array.isArray(embedding) ||
				embedding.length === 0 ||
				!embedding.every(
					(value) => typeof value === "number" && Number.isFinite(value),
				)
			) {
				throw new Error(
					`embedding response item ${index} has no valid embedding`,
				);
			}
			const vector = embedding as number[];
			if (dimensions === undefined) {
				dimensions = vector.length;
			} else if (vector.length !== dimensions) {
				throw new Error(
					`embedding response dimension conflict: expected ${dimensions}, received ${vector.length}`,
				);
			}
			vectors[index] = vector;
		}
		return vectors;
	}
}
