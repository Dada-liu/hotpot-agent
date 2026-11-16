import { createHash, randomUUID } from "node:crypto";
import {
	open,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	utimes,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
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
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".pyi",
	".rs",
	".go",
	".java",
	".kt",
	".kts",
	".swift",
	".c",
	".h",
	".cc",
	".hh",
	".cpp",
	".cxx",
	".hpp",
	".cs",
	".rb",
	".php",
	".scala",
	".sc",
	".sh",
	".bash",
	".zsh",
	".fish",
	".sql",
	".vue",
	".svelte",
	".astro",
	".dart",
	".ex",
	".exs",
	".erl",
	".hrl",
	".fs",
	".fsx",
	".clj",
	".cljs",
	".lua",
	".r",
	".m",
	".mm",
	".pl",
	".pm",
	".zig",
]);
const SENSITIVE_BASENAMES = new Set([
	".env",
	".netrc",
	".npmrc",
	".pypirc",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
]);
const SENSITIVE_STEMS = new Set([
	"secret",
	"secrets",
	"credential",
	"credentials",
	"password",
	"passwords",
	"token",
	"tokens",
	"private-key",
	"private_key",
]);
const PRIVATE_KEY_SUFFIXES = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
	".kdbx",
	".gpg",
	".asc",
];

interface DiscoveredFile {
	hash: string;
	text?: string;
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

function isEligibleSource(name: string): boolean {
	const lower = name.toLowerCase();
	if (lower === ".env" || lower.startsWith(".env.")) return false;
	if (
		SENSITIVE_BASENAMES.has(lower) ||
		PRIVATE_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix))
	) {
		return false;
	}
	let extension: string | undefined;
	for (const candidate of SOURCE_EXTENSIONS) {
		if (lower.endsWith(candidate)) {
			extension = candidate;
			break;
		}
	}
	if (extension === undefined) return false;
	return !SENSITIVE_STEMS.has(lower.slice(0, -extension.length));
}

async function scanFiles(
	cwd: string,
	excludedDirectory: string,
	completeFileHashes: ReadonlyMap<string, string>,
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
			if (!entry.isFile() || !isEligibleSource(entry.name)) continue;
			const info = await stat(absolute);
			if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
			const bytes = await readFile(absolute);
			if (bytes.includes(0)) continue;
			const path = relative(cwd, absolute).split(/[\\/]/).join("/");
			const contentHash = hash(bytes);
			if (completeFileHashes.get(path) === contentHash) {
				files.set(path, { hash: contentHash });
				continue;
			}
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				continue;
			}
			files.set(path, { hash: contentHash, text });
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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown): Map<string, IndexedFile> | null {
	if (!isObject(value) || value.version !== 1 || !isObject(value.files)) {
		return null;
	}
	const files = new Map<string, IndexedFile>();
	for (const [path, entry] of Object.entries(value.files)) {
		if (
			path === "" ||
			!isObject(entry) ||
			typeof entry.hash !== "string" ||
			!Array.isArray(entry.chunkIds) ||
			!entry.chunkIds.every((id) => typeof id === "string" && id !== "")
		) {
			return null;
		}
		files.set(path, { hash: entry.hash, chunkIds: [...entry.chunkIds] });
	}
	return files;
}

async function readManifest(
	path: string,
): Promise<Map<string, IndexedFile> | null> {
	try {
		return parseManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
	} catch {
		return null;
	}
}

async function writeManifest(
	path: string,
	indexed: Map<string, IndexedFile>,
): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx");
		try {
			const data = new TextEncoder().encode(
				JSON.stringify({ version: 1, files: Object.fromEntries(indexed) }),
			);
			let offset = 0;
			while (offset < data.byteLength) {
				const { bytesWritten } = await handle.write(data.subarray(offset));
				if (bytesWritten <= 0)
					throw new Error("manifest write made no progress");
				offset += bytesWritten;
			}
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return isObject(error) && typeof error.code === "string"
		? error.code
		: undefined;
}

function waitForLock(signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, 25);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

const LOCK_STALE_MS = 10_000;
const LOCK_HEARTBEAT_MS = 1_000;

async function createOwnedFile(path: string, owner: string): Promise<void> {
	const handle = await open(path, "wx");
	try {
		const data = new TextEncoder().encode(owner);
		let offset = 0;
		while (offset < data.byteLength) {
			const { bytesWritten } = await handle.write(data.subarray(offset));
			if (bytesWritten <= 0) {
				throw new Error("project lock write made no progress");
			}
			offset += bytesWritten;
		}
		await handle.close();
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(path).catch(() => {});
		throw error;
	}
}

function startHeartbeat(path: string, owner: string): () => Promise<void> {
	let stopped = false;
	let heartbeat: Promise<void> = Promise.resolve();
	const timer = setInterval(() => {
		heartbeat = heartbeat
			.then(async () => {
				if (stopped || (await readFile(path, "utf8")) !== owner) return;
				await utimes(path, new Date(), new Date());
			})
			.catch(() => {});
	}, LOCK_HEARTBEAT_MS);
	(timer as { unref?: () => void }).unref?.();
	return async () => {
		stopped = true;
		clearInterval(timer);
		await heartbeat;
	};
}

// 所有共享锁删除都先登记唯一意向；新锁在意向清空前不能进入临界区。
// 这样多个回收者即使交错，也不会删掉已经投入使用的新锁。
async function withLockIntent(
	path: string,
	operation: () => Promise<void>,
): Promise<void> {
	const owner = randomUUID();
	const intentPath = `${path}.${owner}.intent`;
	await createOwnedFile(intentPath, owner);
	const stopHeartbeat = startHeartbeat(intentPath, owner);
	try {
		await operation();
	} finally {
		await stopHeartbeat();
		await unlink(intentPath).catch((error) => {
			if (errorCode(error) !== "ENOENT") throw error;
		});
	}
}

async function removeOwnedLock(path: string, owner: string): Promise<void> {
	await withLockIntent(path, async () => {
		try {
			if ((await readFile(path, "utf8")) === owner) await unlink(path);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	});
}

async function reclaimStaleLock(
	path: string,
	signal: AbortSignal,
): Promise<void> {
	await withLockIntent(path, async () => {
		try {
			const observed = await stat(path);
			if (Date.now() - observed.mtimeMs < LOCK_STALE_MS) return;
			const observedOwner = await readFile(path, "utf8");
			await waitForLock(signal);
			const current = await stat(path);
			const currentOwner = await readFile(path, "utf8");
			if (
				current.mtimeMs === observed.mtimeMs &&
				currentOwner === observedOwner &&
				Date.now() - current.mtimeMs >= LOCK_STALE_MS
			) {
				await unlink(path);
			}
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	});
}

async function hasActiveLockIntents(path: string): Promise<boolean> {
	const directory = dirname(path);
	const prefix = `${basename(path)}.`;
	const entries = await readdir(directory, { withFileTypes: true });
	let active = false;
	for (const entry of entries) {
		if (
			!entry.isFile() ||
			!entry.name.startsWith(prefix) ||
			!entry.name.endsWith(".intent")
		) {
			continue;
		}
		const intentPath = join(directory, entry.name);
		try {
			const info = await stat(intentPath);
			if (Date.now() - info.mtimeMs >= LOCK_STALE_MS) {
				await unlink(intentPath);
			} else {
				active = true;
			}
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
	return active;
}

async function acquireProjectLock(
	path: string,
	signal: AbortSignal,
): Promise<() => Promise<void>> {
	const owner = randomUUID();
	for (;;) {
		signal.throwIfAborted();
		try {
			await createOwnedFile(path, owner);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			await reclaimStaleLock(path, signal);
			await waitForLock(signal);
			continue;
		}

		const stopHeartbeat = startHeartbeat(path, owner);
		try {
			while (await hasActiveLockIntents(path)) {
				await waitForLock(signal);
			}
		} catch (error) {
			await stopHeartbeat();
			await removeOwnedLock(path, owner);
			throw error;
		}
		return async () => {
			await stopHeartbeat();
			await removeOwnedLock(path, owner);
		};
	}
}

// 仅在实际检索时扫描和打开向量库；文件内容哈希用于跳过未修改文件的 embedding。
export function createCodeIndexService(
	options: CodeIndexOptions,
): CodeIndexService {
	const cwd = resolve(options.cwd);
	const projectKey = hash(cwd);
	const storeDirectory = resolve(options.home, "memory", "vectors");
	const manifestPath = join(storeDirectory, `${projectKey}.manifest.json`);
	const indexed = new Map<string, IndexedFile>();
	let storePromise: Promise<VectorStore> | null = null;

	function openStore(): Promise<VectorStore> {
		storePromise ??= VectorStore.open({
			home: options.home,
			projectKey,
			model: options.model,
		});
		return storePromise;
	}

	async function loadState(): Promise<{
		records: Awaited<ReturnType<VectorStore["list"]>>;
		manifestMissing: boolean;
	}> {
		const records = await (await openStore()).list(CODE_NAMESPACE);
		const manifest = await readManifest(manifestPath);
		indexed.clear();
		if (manifest !== null) {
			for (const [path, file] of manifest) indexed.set(path, file);
		} else {
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
		}
		return { records, manifestMissing: manifest === null };
	}

	async function refresh(signal: AbortSignal): Promise<void> {
		await openStore();
		const release = await acquireProjectLock(
			join(storeDirectory, `${projectKey}.lock`),
			signal,
		);
		try {
			const store = await VectorStore.open({
				home: options.home,
				projectKey,
				model: options.model,
			});
			storePromise = Promise.resolve(store);
			await refreshLocked(signal);
		} finally {
			await release();
		}
	}

	async function refreshLocked(signal: AbortSignal): Promise<void> {
		const { records, manifestMissing } = await loadState();
		const actualIds = new Set(records.map((record) => record.id));
		const expectedIds = new Set(
			[...indexed.values()].flatMap((file) => file.chunkIds),
		);
		const removedIds: string[] = [];
		if (!manifestMissing) {
			for (const id of actualIds) {
				if (!expectedIds.has(id)) removedIds.push(id);
			}
		}
		const completeFileHashes = new Map<string, string>();
		for (const [path, file] of indexed) {
			if (file.chunkIds.every((id) => actualIds.has(id))) {
				completeFileHashes.set(path, file.hash);
			}
		}
		const discovered = await scanFiles(cwd, storeDirectory, completeFileHashes);
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
			const missingChunks =
				previous?.chunkIds.some((id) => !actualIds.has(id)) === true;
			if (previous?.hash === file.hash && !missingChunks) continue;
			if (file.text === undefined) {
				throw new Error("changed source content was not retained");
			}
			if (previous !== undefined) removedIds.push(...previous.chunkIds);
			changed.push({ path, file, chunks: chunkFile(path, file.text) });
		}
		if (
			changed.length === 0 &&
			deletedFiles === 0 &&
			removedIds.length === 0 &&
			!manifestMissing
		) {
			return;
		}

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
		await store.remove([...new Set(removedIds)]);
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
		await writeManifest(manifestPath, indexed);
		if (changed.length + deletedFiles > 0 || removedIds.length > 0) {
			await options.onIndexed?.({
				files: changed.length + deletedFiles,
				chunks: chunks.length,
				durationMs: Math.max(0, Date.now() - startedAt),
			});
		}
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
