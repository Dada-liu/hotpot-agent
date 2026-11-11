import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VectorRecord } from "../src/types.ts";
import { VectorStore } from "../src/vector-store.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-vector-store-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function openStore(model = "embed-v1"): Promise<VectorStore> {
	return VectorStore.open({ home, projectKey: "project-a", model });
}

function record(
	id: string,
	namespace: string,
	vector: number[],
	text = `text-${id}`,
): VectorRecord {
	return {
		id,
		namespace,
		text,
		vector,
		metadata: { source: `${id}.ts` },
	};
}

describe("VectorStore", () => {
	it("写入约定路径并按精确余弦相似度降序返回最近邻", async () => {
		const store = await openStore();
		await store.upsert([
			record("orthogonal", "src", [0, 1]),
			record("nearest", "src", [1, 0]),
			record("second", "src", [0.8, 0.6]),
		]);

		const results = await store.search([1, 0], {
			namespace: "src",
			limit: 2,
		});

		expect(store.filePath).toBe(
			join(home, "memory", "vectors", "project-a.jsonl"),
		);
		expect(results.map((result) => result.id)).toEqual(["nearest", "second"]);
		expect(results[0]?.score).toBeCloseTo(1);
		expect(results[1]?.score).toBeCloseTo(0.8);
	});

	it("search 只返回指定 namespace 的记录", async () => {
		const store = await openStore();
		await store.upsert([
			record("source", "src", [1, 0]),
			record("test", "test", [1, 0]),
		]);

		const results = await store.search([1, 0], {
			namespace: "src",
			limit: 10,
		});
		expect(results.map((result) => result.id)).toEqual(["source"]);
	});

	it("同 id upsert 替换旧记录，remove 追加 tombstone 后不再返回", async () => {
		const store = await openStore();
		await store.upsert([record("chunk", "src", [1, 0], "old text")]);
		await store.upsert([
			{
				...record("chunk", "src", [0, 1], "new text"),
				metadata: { source: "new.ts", line: 8 },
			},
		]);

		const updated = await store.search([0, 1], {
			namespace: "src",
			limit: 10,
		});
		expect(updated).toHaveLength(1);
		expect(updated[0]?.text).toBe("new text");
		expect(updated[0]?.metadata).toEqual({ source: "new.ts", line: 8 });

		await store.remove(["chunk"]);
		await expect(
			store.search([0, 1], { namespace: "src", limit: 10 }),
		).resolves.toEqual([]);
	});

	it("remove 混合空 id 时整批拒绝，当前实例与重启后都不删除记录", async () => {
		const store = await openStore();
		await store.upsert([record("chunk", "src", [1, 0])]);

		await expect(store.remove(["chunk", ""])).rejects.toThrow(/id/i);
		await expect(
			store.search([1, 0], { namespace: "src", limit: 10 }),
		).resolves.toMatchObject([{ id: "chunk" }]);

		const reopened = await openStore();
		await expect(
			reopened.search([1, 0], { namespace: "src", limit: 10 }),
		).resolves.toMatchObject([{ id: "chunk" }]);
	});

	it("新实例从 JSONL 重建最新状态，已删除记录不会复活", async () => {
		const store = await openStore();
		await store.upsert([
			record("keep", "src", [1, 0]),
			record("delete", "src", [0, 1]),
		]);
		await store.remove(["delete"]);

		const reopened = await openStore();
		const results = await reopened.search([1, 0], {
			namespace: "src",
			limit: 10,
		});
		expect(results.map((result) => result.id)).toEqual(["keep"]);
	});

	it("重启加载跳过坏 JSON 与形状非法的行，保留有效记录", async () => {
		const store = await openStore();
		await store.upsert([record("valid", "src", [1, 0], "kept")]);
		await appendFile(
			store.filePath,
			'{not json}\n{"type":"upsert","model":"embed-v1"}\n',
		);

		const reopened = await openStore();
		await expect(
			reopened.search([1, 0], { namespace: "src", limit: 10 }),
		).resolves.toMatchObject([{ id: "valid", text: "kept" }]);
	});

	it("已有数据的模型与当前配置冲突时明确报错", async () => {
		const store = await openStore("embed-v1");
		await store.upsert([record("chunk", "src", [1, 0])]);

		await expect(openStore("embed-v2")).rejects.toThrow(/model.*conflict/i);
	});

	it("upsert 与 search 的向量维度必须和已存数据一致", async () => {
		const store = await openStore();
		await store.upsert([record("chunk", "src", [1, 0])]);

		await expect(
			store.upsert([record("other", "src", [1, 0, 0])]),
		).rejects.toThrow(/dimension.*conflict/i);
		await expect(
			store.search([1, 0, 0], { namespace: "src", limit: 10 }),
		).rejects.toThrow(/dimension.*conflict/i);
	});

	it("单批 upsert 维度不一致时整批拒绝，不向日志写入部分记录", async () => {
		const store = await openStore();
		await expect(
			store.upsert([
				record("two-dimensional", "src", [1, 0]),
				record("three-dimensional", "src", [1, 0, 0]),
			]),
		).rejects.toThrow(/dimension.*conflict/i);

		await store.upsert([record("valid", "src", [1, 0])]);
		const reopened = await openStore();
		const results = await reopened.search([1, 0], {
			namespace: "src",
			limit: 10,
		});
		expect(results.map((result) => result.id)).toEqual(["valid"]);
	});

	it("FileHandle 短写时循环写完整内容，重启后可恢复记录", async () => {
		const store = await openStore();
		const probe = await open(store.filePath, "a");
		const prototype = Object.getPrototypeOf(probe) as {
			write(data: string | Uint8Array): Promise<{ bytesWritten: number }>;
		};
		await probe.close();
		const originalWrite = prototype.write;
		let writeCount = 0;
		prototype.write = function (data) {
			writeCount += 1;
			const length = typeof data === "string" ? data.length : data.byteLength;
			const shortLength = Math.max(1, Math.floor(length / 2));
			return originalWrite.call(
				this,
				typeof data === "string"
					? data.slice(0, shortLength)
					: data.subarray(0, shortLength),
			);
		};
		try {
			await store.upsert([
				record("short-write", "src", [1, 0], "private source text"),
			]);
			expect(writeCount).toBeGreaterThan(1);
		} finally {
			prototype.write = originalWrite;
		}

		const reopened = await openStore();
		await expect(
			reopened.search([1, 0], { namespace: "src", limit: 10 }),
		).resolves.toMatchObject([
			{ id: "short-write", text: "private source text" },
		]);
	});

	it("重启时发现历史记录维度冲突会明确报错", async () => {
		const filePath = join(home, "memory", "vectors", "project-a.jsonl");
		const store = await openStore();
		await store.upsert([record("first", "src", [1, 0])]);
		await writeFile(
			filePath,
			`${JSON.stringify({ type: "upsert", model: "embed-v1", record: record("second", "src", [1, 0, 0]) })}\n`,
			{ flag: "a" },
		);

		await expect(openStore()).rejects.toThrow(/dimension.*conflict/i);
	});
});
