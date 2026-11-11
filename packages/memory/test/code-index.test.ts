import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodeIndexService } from "../src/code-index.ts";
import type { EmbeddingClient } from "../src/embedding.ts";
import type { CodeIndexAudit } from "../src/types.ts";
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
): ReturnType<typeof createCodeIndexService> {
	return createCodeIndexService({
		cwd,
		home,
		model: "embed-v1",
		embedding: fake.embedding,
		onIndexed: async (audit) => {
			audits.push(audit);
		},
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

		expect(batches.map((batch) => batch.length)).toEqual([16, 16, 3, 1]);
		const indexedTexts = batches.slice(0, 3).flat();
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
