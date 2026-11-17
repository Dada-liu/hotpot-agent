import type { EmbeddingClient } from "./embedding.ts";

export interface EmbeddingConfig {
	model: string;
	baseUrl: string;
	// 可省略或为空串：Ollama 等本地 OpenAI 兼容服务通常不校验凭证
	apiKey?: string;
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

// 建索引进度：文件按「落盘窗口」推进，已落盘的文件下次启动不会重复 embedding。
// 只含计数，不含路径或源码
export interface CodeIndexProgress {
	indexedFiles: number;
	totalFiles: number;
	indexedChunks: number;
	totalChunks: number;
}

export interface CodeSearchResult {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	excerpt: string;
}

// 索引规模快照：files=0 表示工作区里没有任何可索引的源码文件
// （典型是只有 .md / 配置文件），此时「查不到」不是检索失败而是没有索引内容
export interface CodeIndexStats {
	files: number;
	chunks: number;
}

export interface CodeIndexService {
	search(
		query: string,
		limit: number,
		signal: AbortSignal,
	): Promise<CodeSearchResult[]>;
	// 最近一次 refresh 之后的索引规模；search() 解决后即为本次检索所用的规模
	stats(): CodeIndexStats;
}

export interface CodeIndexOptions {
	cwd: string;
	home: string;
	model: string;
	embedding: Pick<EmbeddingClient, "embed">;
	onIndexed?: (audit: CodeIndexAudit) => Promise<void>;
	// 建索引过程中逐落盘窗口回调；用于把进度落到会话事件里给 UI 展示
	onProgress?: (progress: CodeIndexProgress) => Promise<void>;
}
