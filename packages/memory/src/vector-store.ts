import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	VectorRecord,
	VectorSearchOptions,
	VectorSearchResult,
	VectorStoreOptions,
} from "./types.ts";

type VectorLogEntry =
	| { type: "upsert"; model: string; record: VectorRecord }
	| { type: "tombstone"; model: string; ids: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validVector(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === "number" && Number.isFinite(item))
	);
}

function parseRecord(value: unknown): VectorRecord | null {
	if (!isObject(value)) {
		return null;
	}
	if (
		typeof value.id !== "string" ||
		value.id === "" ||
		typeof value.namespace !== "string" ||
		value.namespace === "" ||
		typeof value.text !== "string" ||
		!validVector(value.vector) ||
		!isObject(value.metadata)
	) {
		return null;
	}
	return {
		id: value.id,
		namespace: value.namespace,
		text: value.text,
		vector: [...value.vector],
		metadata: { ...value.metadata },
	};
}

function parseEntry(value: unknown): VectorLogEntry | null {
	if (!isObject(value) || typeof value.model !== "string") {
		return null;
	}
	if (value.type === "upsert") {
		const record = parseRecord(value.record);
		return record === null
			? null
			: { type: "upsert", model: value.model, record };
	}
	if (
		value.type === "tombstone" &&
		Array.isArray(value.ids) &&
		value.ids.every((id) => typeof id === "string" && id !== "")
	) {
		return { type: "tombstone", model: value.model, ids: [...value.ids] };
	}
	return null;
}

function cosineSimilarity(left: number[], right: number[]): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	if (leftNorm === 0 || rightNorm === 0) {
		return 0;
	}
	return dot / Math.sqrt(leftNorm * rightNorm);
}

// 本地精确向量库：append-only JSONL 为事实源，内存 Map 只是重启可重建的投影
export class VectorStore {
	readonly filePath: string;
	private readonly model: string;
	private readonly records: Map<string, VectorRecord>;
	private dimensions: number | undefined;
	private writeQueue: Promise<void>;

	private constructor(options: VectorStoreOptions) {
		if (options.projectKey === "" || options.projectKey.includes("/")) {
			throw new Error("projectKey must be a non-empty file-name component");
		}
		if (options.model === "") {
			throw new Error("vector model must not be empty");
		}
		this.model = options.model;
		this.filePath = join(
			options.home,
			"memory",
			"vectors",
			`${options.projectKey}.jsonl`,
		);
		this.records = new Map();
		this.writeQueue = Promise.resolve();
	}

	static async open(options: VectorStoreOptions): Promise<VectorStore> {
		const store = new VectorStore(options);
		await mkdir(dirname(store.filePath), { recursive: true });
		if (!existsSync(store.filePath)) {
			return store;
		}
		const text = await readFile(store.filePath, "utf8");
		for (const line of text.split("\n")) {
			if (line.trim() === "") {
				continue;
			}
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch {
				continue; // 崩溃留下的半截 JSON 等坏行不影响其他记录
			}
			const entry = parseEntry(value);
			if (entry !== null) {
				store.apply(entry);
			}
		}
		return store;
	}

	private apply(entry: VectorLogEntry): void {
		if (entry.model !== this.model) {
			throw new Error(
				`vector model conflict: expected ${this.model}, found ${entry.model}`,
			);
		}
		if (entry.type === "tombstone") {
			for (const id of entry.ids) {
				this.records.delete(id);
			}
			return;
		}
		const dimension = entry.record.vector.length;
		if (this.dimensions !== undefined && dimension !== this.dimensions) {
			throw new Error(
				`vector dimension conflict: expected ${this.dimensions}, found ${dimension}`,
			);
		}
		this.dimensions = dimension;
		this.records.set(entry.record.id, entry.record);
	}

	private enqueue(createEntries: () => VectorLogEntry[]): Promise<void> {
		const operation = this.writeQueue.then(async () => {
			const entries = createEntries();
			if (entries.length === 0) {
				return;
			}
			const contents = entries
				.map((entry) => `${JSON.stringify(entry)}\n`)
				.join("");
			const handle = await open(this.filePath, "a");
			try {
				// FileHandle.write 可能短写；按实际字节数续写，完整落盘后才 fsync
				const data = new TextEncoder().encode(contents);
				let offset = 0;
				while (offset < data.byteLength) {
					const { bytesWritten } = await handle.write(data.subarray(offset));
					if (bytesWritten <= 0) {
						throw new Error("vector store write made no progress");
					}
					offset += bytesWritten;
				}
				await handle.sync();
			} finally {
				await handle.close();
			}
			for (const entry of entries) {
				this.apply(entry);
			}
		});
		this.writeQueue = operation.catch(() => {});
		return operation;
	}

	async upsert(records: VectorRecord[]): Promise<void> {
		const normalized = records.map((record) => {
			const parsed = parseRecord(record);
			if (parsed === null) {
				throw new Error("invalid vector record");
			}
			return parsed;
		});
		await this.enqueue(() => {
			let dimensions = this.dimensions;
			for (const record of normalized) {
				const dimension = record.vector.length;
				if (dimensions !== undefined && dimension !== dimensions) {
					throw new Error(
						`vector dimension conflict: expected ${dimensions}, found ${dimension}`,
					);
				}
				dimensions = dimension;
			}
			return normalized.map((record) => ({
				type: "upsert",
				model: this.model,
				record,
			}));
		});
	}

	async remove(ids: string[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		if (ids.some((id) => id === "")) {
			throw new Error("vector record id must not be empty");
		}
		await this.enqueue(() => [
			{ type: "tombstone", model: this.model, ids: [...ids] },
		]);
	}

	async search(
		vector: number[],
		options: VectorSearchOptions,
	): Promise<VectorSearchResult[]> {
		if (!validVector(vector)) {
			throw new Error("search vector must contain finite numbers");
		}
		if (!Number.isInteger(options.limit) || options.limit < 0) {
			throw new Error("search limit must be a non-negative integer");
		}
		if (this.dimensions !== undefined && vector.length !== this.dimensions) {
			throw new Error(
				`vector dimension conflict: expected ${this.dimensions}, found ${vector.length}`,
			);
		}
		return [...this.records.values()]
			.filter((record) => record.namespace === options.namespace)
			.map((record) => ({
				...record,
				vector: [...record.vector],
				metadata: { ...record.metadata },
				score: cosineSimilarity(vector, record.vector),
			}))
			.sort(
				(left, right) =>
					right.score - left.score || left.id.localeCompare(right.id),
			)
			.slice(0, options.limit);
	}
}
