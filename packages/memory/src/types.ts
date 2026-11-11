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
