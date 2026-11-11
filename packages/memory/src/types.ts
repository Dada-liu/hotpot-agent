import type { EmbeddingClient } from "./embedding.ts";

export interface EmbeddingConfig {
	model: string;
	baseUrl: string;
	apiKey: string;
}

export interface VectorRecord {
	id: string;
	namespace: string;
	text: string;
	vector: number[];
	metadata: Record<string, unknown>;
}

export interface VectorSearchResult extends VectorRecord {
	score: number;
}

export interface VectorStoreOptions {
	home: string;
	projectKey: string;
	model: string;
}

export interface VectorSearchOptions {
	namespace: string;
	limit: number;
}

export interface CodeIndexAudit {
	files: number;
	chunks: number;
	durationMs: number;
}

export interface CodeSearchResult {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	excerpt: string;
}

export interface CodeIndexService {
	search(
		query: string,
		limit: number,
		signal: AbortSignal,
	): Promise<CodeSearchResult[]>;
}

export interface CodeIndexOptions {
	cwd: string;
	home: string;
	model: string;
	embedding: Pick<EmbeddingClient, "embed">;
	onIndexed?: (audit: CodeIndexAudit) => Promise<void>;
}
