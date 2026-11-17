import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodeIndexService } from "../src/code-index.ts";
import type { EmbeddingClient } from "../src/embedding.ts";
import type { CodeIndexAudit, CodeIndexProgress } from "../src/types.ts";
import { VectorStore } from "../src/vector-store.ts";

interface FakeEmbedding {
	embedding: Pick<EmbeddingClient, "embed">;
	batches: string[][];
}

function fakeEmbedding(): FakeEmbedding {
	const batches: string[][] = [];
	return {
		batches,
		embedding: {
			async embed(texts, signal) {
				signal.throwIfAborted();
				batches.push([...texts]);
				return texts.map((text) => {
					if (text.includes("alpha")) return [1, 0];
					if (text.includes("beta")) return [0, 1];
					return [0.5, 0.5];
				});
			},
		},
	};
}

let root: string;
let home: string;
let cwd: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hotpot-code-index-test-"));
	home = join(root, "home");
	cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function serviceWith(
	fake: FakeEmbedding,
	audits: CodeIndexAudit[] = [],
	progress: CodeIndexProgress[] = [],
): ReturnType<typeof createCodeIndexService> {
	return createCodeIndexService({
		cwd,
		home,
		model: "embed-v1",
		embedding: fake.embedding,
		onIndexed: async (audit) => {
			audits.push(audit);
		},
		onProgress: async (entry) => {
			progress.push(entry);
		},
	});
}

function openProjectStore(): Promise<VectorStore> {
	return VectorStore.open({
		home,
		projectKey: createHash("sha256").update(resolve(cwd)).digest("hex"),
		model: "embed-v1",
	});
}

describe("CodeIndexService", () => {
	it("首次索引按约 1200 字符、200 重叠分块，并返回相对路径与准确行号", async () => {
		await mkdir(join(cwd, "src", "nested"), { recursive: true });
		const source = `first\n${"x".repeat(1194)}${"y".repeat(200)}`;
		await writeFile(join(cwd, "src", "nested", "example.ts"), source);
		const fake = fakeEmbedding();
		const service = serviceWith(fake);

		const results = await service.search(
			"first",
			10,
			new AbortController().signal,
		);

		expect(fake.batches[0]?.map((text) => text.length)).toEqual([1200, 400]);
		expect(fake.batches[0]?.[1]?.startsWith("x".repeat(200))).toBe(true);
		expect(results).toHaveLength(2);
		expect(
			results.every((result) => result.path === "src/nested/example.ts"),
		).toBe(true);
		expect(results.map((result) => [result.startLine, result.endLine])).toEqual(
			[
				[1, 2],
				[2, 2],
			],
		);
	});

	it("首次索引按有界批次请求并保持 chunk 与向量顺序", async () => {
		await writeFile(join(cwd, "many.ts"), `${"x".repeat(34_100)}needle`);
		const batches: string[][] = [];
		const fake: FakeEmbedding = {
			batches,
			embedding: {
				async embed(texts, signal) {
					signal.throwIfAborted();
					batches.push([...texts]);
					return texts.map((text) =>
						text.includes("needle") ? [1, 0] : [0, 1],
					);
				},
			},
		};
		const service = serviceWith(fake);

		const results = await service.search(
			"needle",
			2,
			new AbortController().signal,
		);

		// 35 个 chunk 按 32 一批（并行在途上限 4）→ 32 + 3；最后 1 批是查询文本
		expect(batches.map((batch) => batch.length)).toEqual([32, 3, 1]);
		const indexedTexts = batches.slice(0, 2).flat();
		expect(indexedTexts).toHaveLength(35);
		expect(indexedTexts[0]?.startsWith("xxx")).toBe(true);
		expect(indexedTexts.at(-1)?.endsWith("needle")).toBe(true);
		expect(results).toHaveLength(2);
		expect(results.every((result) => result.score === 1)).toBe(true);

		const store = await VectorStore.open({
			home,
			projectKey: createHash("sha256").update(resolve(cwd)).digest("hex"),
			model: "embed-v1",
		});
		const records = await store.list("code");
		expect(records).toHaveLength(35);
		expect(
			records.every((record) =>
				record.vector.every(
					(value, index) =>
						value === (record.text.includes("needle") ? [1, 0] : [0, 1])[index],
				),
			),
		).toBe(true);
	});

	it("内容未变化时刷新不产生索引 embedding 调用，也不重复写审计", async () => {
		await writeFile(join(cwd, "alpha.ts"), "export const alpha = 1;\n");
		const fake = fakeEmbedding();
		const audits: CodeIndexAudit[] = [];
		const service = serviceWith(fake, audits);
		const signal = new AbortController().signal;

		await service.search("alpha", 5, signal);
		const batchesAfterFirst = fake.batches.length;
		await service.search("alpha", 5, signal);

		expect(fake.batches.slice(batchesAfterFirst)).toEqual([["alpha"]]);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ files: 1, chunks: 1 });
		expect(audits[0]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(Object.keys(audits[0] ?? {}).sort()).toEqual([
			"chunks",
			"durationMs",
			"files",
		]);
	});

	it("并发首次检索共享一次索引写入与审计", async () => {
		await writeFile(join(cwd, "alpha.ts"), "export const alpha = 1;\n");
		const fake = fakeEmbedding();
		const audits: CodeIndexAudit[] = [];
		const service = serviceWith(fake, audits);
		const signal = new AbortController().signal;

		await Promise.all([
			service.search("alpha", 5, signal),
			service.search("alpha", 5, signal),
		]);

		expect(
			fake.batches.filter(
				(batch) => batch.length === 1 && batch[0]?.includes("export"),
			),
		).toHaveLength(1);
		expect(audits).toHaveLength(1);
	});

	it("修改文件后替换旧 chunk，旧内容不可检索而新内容可检索", async () => {
		const file = join(cwd, "changing.ts");
		await writeFile(file, "export const alpha = 'old';\n");
		const fake = fakeEmbedding();
		const service = serviceWith(fake);
		const signal = new AbortController().signal;
		expect(await service.search("alpha", 5, signal)).toHaveLength(1);

		await writeFile(file, "export const beta = 'new';\n");

		const oldResults = await service.search("alpha", 5, signal);
		expect(oldResults.map((result) => result.excerpt)).toEqual([
			"export const beta = 'new';\n",
		]);
		expect(await service.search("beta", 5, signal)).toMatchObject([
			{ path: "changing.ts", startLine: 1, endLine: 1 },
		]);
	});

	it("删除文件后删除其全部 chunk", async () => {
		const file = join(cwd, "deleted.ts");
		await writeFile(file, "export const alpha = true;\n");
		const service = serviceWith(fakeEmbedding());
		const signal = new AbortController().signal;
		expect(await service.search("alpha", 5, signal)).toHaveLength(1);

		await rm(file);

		expect(await service.search("alpha", 5, signal)).toEqual([]);
	});

	it("服务重启后重建清单：未修改不重复索引，修改与删除不留下旧 chunk", async () => {
		const file = join(cwd, "restart.ts");
		await writeFile(file, "export const alpha = 'old';\n");
		const fake = fakeEmbedding();
		const signal = new AbortController().signal;
		await serviceWith(fake).search("alpha", 5, signal);
		const afterFirst = fake.batches.length;

		await serviceWith(fake).search("alpha", 5, signal);
		expect(fake.batches.slice(afterFirst)).toEqual([["alpha"]]);

		await writeFile(file, "export const beta = 'new';\n");
		const modified = await serviceWith(fake).search("alpha", 5, signal);
		expect(modified.map((result) => result.excerpt)).toEqual([
			"export const beta = 'new';\n",
		]);

		await rm(file);
		expect(await serviceWith(fake).search("alpha", 5, signal)).toEqual([]);
	});

	it("两个 service 交错索引时，重开后只保留当前文件版本", async () => {
		const file = join(cwd, "concurrent.ts");
		await writeFile(file, "export const alpha = 'v1';\n");
		let delayFirst = true;
		let started: (() => void) | undefined;
		let release: (() => void) | undefined;
		const embeddingStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fakeA: FakeEmbedding = {
			batches: [],
			embedding: {
				async embed(texts, signal) {
					signal.throwIfAborted();
					if (delayFirst) {
						delayFirst = false;
						started?.();
						await gate;
					}
					return texts.map((text) =>
						text.includes("alpha") ? [1, 0] : [0, 1],
					);
				},
			},
		};
		const pendingA = serviceWith(fakeA).search(
			"alpha",
			5,
			new AbortController().signal,
		);
		await embeddingStarted;

		await writeFile(file, "export const beta = 'v2';\n");
		const pendingB = serviceWith(fakeEmbedding()).search(
			"beta",
			5,
			new AbortController().signal,
		);
		release?.();
		await Promise.all([pendingA, pendingB]);

		const reopened = await openProjectStore();
		expect((await reopened.list("code")).map((record) => record.text)).toEqual([
			"export const beta = 'v2';\n",
		]);
	});

	it("embedding 异常或中止都会释放项目锁，允许后续 service 重试", async () => {
		const file = join(cwd, "cleanup.ts");
		for (const mode of ["error", "abort"] as const) {
			await writeFile(file, `export const ${mode} = '${mode}';\n`);
			const controller = new AbortController();
			const failing: FakeEmbedding = {
				batches: [],
				embedding: {
					async embed(_texts, signal) {
						if (mode === "abort") controller.abort();
						signal.throwIfAborted();
						throw new Error("embedding failed");
					},
				},
			};
			await expect(
				serviceWith(failing).search("alpha", 5, controller.signal),
			).rejects.toBeDefined();

			const results = await serviceWith(fakeEmbedding()).search(
				"alpha",
				5,
				new AbortController().signal,
			);
			expect(results).toHaveLength(1);
		}
	});

	it("多个等待方可并发回收崩溃残留锁，后续索引不再阻塞", async () => {
		await writeFile(join(cwd, "alpha.ts"), "export const alpha = 1;\n");
		const projectKey = createHash("sha256").update(resolve(cwd)).digest("hex");
		const vectors = join(home, "memory", "vectors");
		await mkdir(vectors, { recursive: true });
		const lockPath = join(vectors, `${projectKey}.lock`);
		await writeFile(lockPath, "");
		await writeFile(`${lockPath}.crashed.intent`, "");
		const staleTime = new Date(Date.now() - 60_000);
		await utimes(lockPath, staleTime, staleTime);
		await utimes(`${lockPath}.crashed.intent`, staleTime, staleTime);
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(new Error("stale lock was not recovered")),
			2_000,
		);

		try {
			const results = await Promise.all(
				Array.from({ length: 8 }, () =>
					serviceWith(fakeEmbedding()).search("alpha", 5, controller.signal),
				),
			);
			for (const result of results) {
				expect(result).toMatchObject([{ path: "alpha.ts" }]);
			}
			expect(await (await openProjectStore()).list("code")).toHaveLength(1);
		} finally {
			clearTimeout(timeout);
		}
	});

	it("等待回收意向期间锁被删除时必须重新获取，不能无锁索引", async () => {
		await writeFile(join(cwd, "alpha.ts"), "export const alpha = 1;\n");
		const projectKey = createHash("sha256").update(resolve(cwd)).digest("hex");
		const vectors = join(home, "memory", "vectors");
		await mkdir(vectors, { recursive: true });
		const lockPath = join(vectors, `${projectKey}.lock`);
		const intentPath = `${lockPath}.blocking.intent`;
		await writeFile(intentPath, "reaper");
		const fake: FakeEmbedding = {
			batches: [],
			embedding: {
				async embed(texts, signal) {
					signal.throwIfAborted();
					if (texts.some((text) => text.includes("export"))) {
						await readFile(lockPath, "utf8");
					}
					return texts.map(() => [1, 0]);
				},
			},
		};
		const pending = serviceWith(fake).search(
			"alpha",
			5,
			new AbortController().signal,
		);
		const deadline = Date.now() + 2_000;
		for (;;) {
			try {
				await readFile(lockPath, "utf8");
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "ENOENT") throw error;
				if (Date.now() >= deadline) throw new Error("project lock not created");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}

		await unlink(lockPath);
		await unlink(intentPath);

		expect(await pending).toMatchObject([{ path: "alpha.ts" }]);
	});

	it("长时间索引通过心跳保活，等待方不会抢占活跃项目锁", async () => {
		const file = join(cwd, "heartbeat.ts");
		await writeFile(file, "export const alpha = 'v1';\n");
		let delayFirst = true;
		let started: (() => void) | undefined;
		let releaseFirst: (() => void) | undefined;
		const embeddingStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const fakeA: FakeEmbedding = {
			batches: [],
			embedding: {
				async embed(texts, signal) {
					signal.throwIfAborted();
					if (delayFirst) {
						delayFirst = false;
						started?.();
						await gate;
					}
					return texts.map(() => [1, 0]);
				},
			},
		};
		const pendingA = serviceWith(fakeA).search(
			"alpha",
			5,
			new AbortController().signal,
		);
		await embeddingStarted;
		await writeFile(file, "export const beta = 'v2';\n");
		const pendingB = serviceWith(fakeEmbedding()).search(
			"beta",
			5,
			new AbortController().signal,
		);

		await new Promise((resolve) => setTimeout(resolve, 11_000));
		releaseFirst?.();
		await Promise.all([pendingA, pendingB]);

		const reopened = await openProjectStore();
		expect((await reopened.list("code")).map((record) => record.text)).toEqual([
			"export const beta = 'v2';\n",
		]);
	}, 15_000);

	it("空文件写入持久 manifest，重启后不重复审计", async () => {
		await writeFile(join(cwd, "empty.ts"), "");
		const fake = fakeEmbedding();
		const audits: CodeIndexAudit[] = [];

		await serviceWith(fake, audits).search(
			"alpha",
			5,
			new AbortController().signal,
		);
		await serviceWith(fake, audits).search(
			"alpha",
			5,
			new AbortController().signal,
		);

		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ files: 1, chunks: 0 });
	});

	it("重启发现多 chunk 索引缺记录时按 manifest 补齐", async () => {
		await writeFile(join(cwd, "partial.ts"), "x".repeat(2500));
		const fake = fakeEmbedding();
		const signal = new AbortController().signal;
		await serviceWith(fake).search("alpha", 5, signal);
		const initialStore = await openProjectStore();
		const initialRecords = await initialStore.list("code");
		expect(initialRecords).toHaveLength(3);
		const missingId = initialRecords[1]?.id;
		if (missingId === undefined) throw new Error("missing test chunk");
		await initialStore.remove([missingId]);
		const audits: CodeIndexAudit[] = [];

		await serviceWith(fake, audits).search("alpha", 5, signal);

		const restored = await openProjectStore();
		expect(await restored.list("code")).toHaveLength(3);
		expect(audits).toMatchObject([{ files: 1, chunks: 3 }]);
	});

	it("纯删除刷新也落一条按变更文件计数的匿名审计", async () => {
		const file = join(cwd, "deleted.ts");
		await writeFile(file, "export const alpha = true;\n");
		const audits: CodeIndexAudit[] = [];
		const service = serviceWith(fakeEmbedding(), audits);
		const signal = new AbortController().signal;
		await service.search("alpha", 5, signal);

		await rm(file);
		await service.search("alpha", 5, signal);

		expect(audits.map(({ files, chunks }) => ({ files, chunks }))).toEqual([
			{ files: 1, chunks: 1 },
			{ files: 1, chunks: 0 },
		]);
	});

	it("home 嵌套在 cwd 内时排除向量库目录，后续检索不自索引", async () => {
		home = join(cwd, "nested-home");
		await writeFile(join(cwd, "alpha.ts"), "export const alpha = 1;\n");
		const fake = fakeEmbedding();
		const service = serviceWith(fake);
		const signal = new AbortController().signal;
		await service.search("alpha", 5, signal);
		const afterFirst = fake.batches.length;

		const results = await service.search("alpha", 5, signal);

		expect(fake.batches.slice(afterFirst)).toEqual([["alpha"]]);
		expect(results.map((result) => result.path)).toEqual(["alpha.ts"]);
		expect(fake.batches.flat().join("\n")).not.toContain('"type":"upsert"');
	});

	it("只索引源码并排除常见密钥/凭证文件，敏感内容不进入 embedding", async () => {
		const fixtures: Record<string, string> = {
			".env": "DO_NOT_UPLOAD=env",
			".env.local": "DO_NOT_UPLOAD=env-local",
			id_rsa: "DO_NOT_UPLOAD private key",
			"credentials.json": '{"token":"DO_NOT_UPLOAD"}',
			"secrets.ts": 'export const secret = "DO_NOT_UPLOAD";',
			"private-key.pem": "DO_NOT_UPLOAD pem",
			"deploy.yaml": "ARBITRARY_TEXT: true",
			"notes.txt": "ARBITRARY_TEXT notes",
			"allowed.ts": "export const alpha = 'safe source';",
		};
		for (const [name, content] of Object.entries(fixtures)) {
			await writeFile(join(cwd, name), content);
		}
		const fake = fakeEmbedding();

		await serviceWith(fake).search("alpha", 20, new AbortController().signal);

		const embedded = fake.batches.flat().join("\n");
		expect(embedded).toContain("safe source");
		expect(embedded).not.toContain("DO_NOT_UPLOAD");
		expect(embedded).not.toContain("ARBITRARY_TEXT");
	});

	it("按窗口分批落盘并上报进度：中断后已落盘的文件不会重新 embedding", async () => {
		// 两个等长大文件：每个约 280 chunk，超过 FLUSH_CHUNKS(256)，
		// 于是每个文件独占一个落盘窗口
		const big = "export const value = 1;\n".repeat(12_000);
		await writeFile(join(cwd, "first.ts"), big);
		await writeFile(join(cwd, "second.ts"), big);
		const signal = new AbortController().signal;
		const progress: CodeIndexProgress[] = [];
		let calls = 0;
		const aborting: FakeEmbedding = {
			batches: [],
			embedding: {
				async embed(texts) {
					calls += 1;
					// 第一个窗口（first.ts）落盘完成后再中断，模拟用户 ESC / 进程退出
					if (calls > 9) throw new Error("aborted");
					return texts.map(() => [1, 0]);
				},
			},
		};

		await expect(
			serviceWith(aborting, [], progress).search("value", 5, signal),
		).rejects.toThrow(/aborted/);

		// 进度先报 0/N，第一个窗口落盘后报 1/2；第二个窗口没跑完，停在 1
		expect(progress[0]).toMatchObject({ indexedFiles: 0, totalFiles: 2 });
		expect(progress.at(-1)?.indexedFiles).toBe(1);
		expect(progress.at(-1)?.indexedChunks).toBeLessThan(
			progress.at(-1)?.totalChunks ?? 0,
		);

		// 中断前已落盘的记录确实进了向量库
		const store = await openProjectStore();
		const afterAbort = await store.list("code");
		expect(afterAbort.length).toBeGreaterThan(0);

		// 重试：只有第二个文件需要重新 embedding（两文件内容相同，chunk 数一致）
		const retry = fakeEmbedding();
		await serviceWith(retry).search("value", 5, signal);
		const embeddedOnRetry = retry.batches.flat().length - 1; // 减去查询文本
		expect(embeddedOnRetry).toBe(afterAbort.length);
		// 重新打开 store：VectorStore 在 open 时载入快照，旧实例看不到重试写入的记录
		expect(await (await openProjectStore()).list("code")).toHaveLength(
			afterAbort.length * 2,
		);
	});

	it("工作区只有文档时索引为空：stats 为 0 且不为 query 发 embedding 请求", async () => {
		await writeFile(join(cwd, "haha.md"), "name: daxia\naget: 19\n");
		await writeFile(join(cwd, "notes.txt"), "hello");
		const fake = fakeEmbedding();
		const service = serviceWith(fake);

		const results = await service.search(
			"name",
			10,
			new AbortController().signal,
		);

		expect(results).toEqual([]);
		expect(service.stats()).toEqual({ files: 0, chunks: 0 });
		// 索引里没有任何 chunk 时直接返回，省掉 query embedding
		expect(fake.batches).toEqual([]);
	});

	it("默认忽略指定目录、符号链接、二进制和超过 512KB 的文件", async () => {
		for (const dir of [".git", "node_modules", "dist", "build", ".hotpot"]) {
			await mkdir(join(cwd, dir), { recursive: true });
			await writeFile(join(cwd, dir, "ignored.ts"), `alpha ${dir}`);
		}
		await writeFile(join(cwd, "binary.ts"), `alpha\0beta`);
		await writeFile(join(cwd, "large.ts"), `alpha${"x".repeat(512 * 1024)}`);
		await writeFile(join(root, "linked-target.txt"), "alpha linked");
		await symlink(join(root, "linked-target.txt"), join(cwd, "linked.ts"));
		await writeFile(
			join(cwd, "included.ts"),
			"export const included = true;\n",
		);
		const fake = fakeEmbedding();
		const service = serviceWith(fake);
		const signal = new AbortController().signal;

		expect(fake.batches).toHaveLength(0);
		await service.search("alpha", 20, signal);

		const embedded = fake.batches.flat().join("\n");
		expect(embedded).toContain("included");
		expect(embedded).not.toContain("ignored");
		expect(embedded).not.toContain("linked");
		expect(embedded).not.toContain("large");
		expect(await service.search("alpha", 20, signal)).toMatchObject([
			{ path: "included.ts" },
		]);
	});
});
