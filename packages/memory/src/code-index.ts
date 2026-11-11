import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
	CodeIndexOptions,
	CodeIndexService,
	CodeSearchResult,
} from "./types.ts";
import { VectorStore } from "./vector-store.ts";

const CODE_NAMESPACE = "code";
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_EXCERPT_CHARS = 800;
const EMBEDDING_BATCH_SIZE = 16;
const IGNORED_ENTRIES = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".hotpot",
]);

interface DiscoveredFile {
	hash: string;
	text: string;
}

interface IndexedFile {
	hash: string;
	chunkIds: string[];
}

interface SourceChunk {
	id: string;
	text: string;
	path: string;
	startLine: number;
	endLine: number;
}

function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function chunkFile(path: string, text: string): SourceChunk[] {
	const lineByOffset: number[] = new Array(text.length + 1);
	let line = 1;
	for (let offset = 0; offset <= text.length; offset += 1) {
		lineByOffset[offset] = line;
		if (text[offset] === "\n") line += 1;
	}

	const chunks: SourceChunk[] = [];
	for (
		let start = 0;
		start < text.length;
		start += CHUNK_SIZE - CHUNK_OVERLAP
	) {
		const end = Math.min(text.length, start + CHUNK_SIZE);
		const chunk = text.slice(start, end);
		chunks.push({
			id: hash(`${path}\0${start}\0${chunk}`),
			text: chunk,
			path,
			startLine: lineByOffset[start] ?? 1,
			endLine: lineByOffset[Math.max(start, end - 1)] ?? 1,
		});
	}
	return chunks;
}

async function scanFiles(
	cwd: string,
	excludedDirectory: string,
): Promise<Map<string, DiscoveredFile>> {
	const files = new Map<string, DiscoveredFile>();

	async function visit(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (IGNORED_ENTRIES.has(entry.name) || entry.isSymbolicLink()) continue;
			const absolute = join(directory, entry.name);
			const fromStore = relative(excludedDirectory, absolute);
			if (
				fromStore === "" ||
				(fromStore !== ".." &&
					!fromStore.startsWith("../") &&
					!fromStore.startsWith("..\\") &&
					!isAbsolute(fromStore))
			) {
				continue;
			}
			if (entry.isDirectory()) {
				await visit(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			const info = await stat(absolute);
			if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
			const bytes = await readFile(absolute);
			if (bytes.includes(0)) continue;
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				continue;
			}
			const path = relative(cwd, absolute).split(/[\\/]/).join("/");
			files.set(path, { hash: hash(bytes), text });
		}
	}

	await visit(cwd);
	return files;
}

function excerpt(text: string): string {
	return text.length <= MAX_EXCERPT_CHARS
		? text
		: `${text.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

// 仅在实际检索时扫描和打开向量库；文件内容哈希用于跳过未修改文件的 embedding。
export function createCodeIndexService(
	options: CodeIndexOptions,
): CodeIndexService {
	const cwd = resolve(options.cwd);
	const projectKey = hash(cwd);
	const indexed = new Map<string, IndexedFile>();
	let storePromise: Promise<VectorStore> | null = null;
	let manifestLoaded = false;

	function openStore(): Promise<VectorStore> {
		storePromise ??= VectorStore.open({
			home: options.home,
			projectKey,
			model: options.model,
		});
		return storePromise;
	}

	async function loadManifest(): Promise<void> {
		if (manifestLoaded) return;
		const records = await (await openStore()).list(CODE_NAMESPACE);
		for (const record of records) {
			const path = record.metadata.path;
			if (typeof path !== "string") continue;
			const fileHash =
				typeof record.metadata.fileHash === "string"
					? record.metadata.fileHash
					: "";
			const current = indexed.get(path) ?? { hash: fileHash, chunkIds: [] };
			current.chunkIds.push(record.id);
			indexed.set(path, current);
		}
		manifestLoaded = true;
	}

	async function refresh(signal: AbortSignal): Promise<void> {
		await loadManifest();
		const discovered = await scanFiles(
			cwd,
			resolve(options.home, "memory", "vectors"),
		);
		const removedIds: string[] = [];
		let deletedFiles = 0;
		const changed: {
			path: string;
			file: DiscoveredFile;
			chunks: SourceChunk[];
		}[] = [];

		for (const [path, previous] of indexed) {
			if (!discovered.has(path)) {
				deletedFiles += 1;
				removedIds.push(...previous.chunkIds);
			}
		}
		for (const [path, file] of discovered) {
			const previous = indexed.get(path);
			if (previous?.hash === file.hash) continue;
			if (previous !== undefined) removedIds.push(...previous.chunkIds);
			changed.push({ path, file, chunks: chunkFile(path, file.text) });
		}
		if (changed.length === 0 && deletedFiles === 0) return;

		const startedAt = Date.now();
		const chunks = changed.flatMap((entry) => entry.chunks);
		const vectors: number[][] = [];
		for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
			const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
			const batchVectors = await options.embedding.embed(
				batch.map((chunk) => chunk.text),
				signal,
			);
			vectors.push(...batchVectors);
		}
		const store = await openStore();
		await store.remove(removedIds);
		if (chunks.length > 0) {
			await store.upsert(
				chunks.map((chunk, index) => ({
					id: chunk.id,
					namespace: CODE_NAMESPACE,
					text: chunk.text,
					vector: vectors[index] ?? [],
					metadata: {
						path: chunk.path,
						fileHash: discovered.get(chunk.path)?.hash ?? "",
						startLine: chunk.startLine,
						endLine: chunk.endLine,
					},
				})),
			);
		}

		for (const path of indexed.keys()) {
			if (!discovered.has(path)) indexed.delete(path);
		}
		for (const entry of changed) {
			indexed.set(entry.path, {
				hash: entry.file.hash,
				chunkIds: entry.chunks.map((chunk) => chunk.id),
			});
		}
		await options.onIndexed?.({
			files: changed.length + deletedFiles,
			chunks: chunks.length,
			durationMs: Math.max(0, Date.now() - startedAt),
		});
	}

	async function search(
		query: string,
		limit: number,
		signal: AbortSignal,
	): Promise<CodeSearchResult[]> {
		await refresh(signal);
		const [queryVector] = await options.embedding.embed([query], signal);
		if (queryVector === undefined) throw new Error("missing query embedding");
		const results = await (await openStore()).search(queryVector, {
			namespace: CODE_NAMESPACE,
			limit,
		});
		const mapped: CodeSearchResult[] = [];
		for (const result of results) {
			const { path, startLine, endLine } = result.metadata;
			if (
				typeof path !== "string" ||
				typeof startLine !== "number" ||
				typeof endLine !== "number"
			) {
				continue;
			}
			mapped.push({
				path,
				startLine,
				endLine,
				score: result.score,
				excerpt: excerpt(result.text),
			});
		}
		return mapped;
	}

	// 多角色共享一个 service：检索串行刷新，避免并发首轮重复索引与审计。
	let searchTail: Promise<void> = Promise.resolve();
	return {
		search(query, limit, signal) {
			const result = searchTail.then(() => search(query, limit, signal));
			searchTail = result.then(
				() => {},
				() => {},
			);
			return result;
		},
	};
}
