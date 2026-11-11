// 分片规则是「结果可复现」的前提：同一份 selection 与同一组参数必须永远得到同一子集，
// 且所有分片拼起来必须恰好覆盖全集（不重不漏）。这两个性质都在这里钉住。

import { describe, expect, it } from "vitest";
import { applyShard, formatShard, parseShard } from "../src/shard.ts";

describe("parseShard", () => {
	it("解析 1 基的 <i>/<n>，内部转成 0 基", () => {
		expect(parseShard("1/3")).toEqual({ index: 0, count: 3 });
		expect(parseShard("3/3")).toEqual({ index: 2, count: 3 });
		expect(parseShard(" 2 / 4 ")).toEqual({ index: 1, count: 4 });
	});

	it("拒绝越界与畸形输入", () => {
		expect(() => parseShard("0/3")).toThrow(/shard index/);
		expect(() => parseShard("4/3")).toThrow(/shard index/);
		expect(() => parseShard("1/0")).toThrow(/shard count/);
		expect(() => parseShard("1")).toThrow(/shard must look like/);
		expect(() => parseShard("a/b")).toThrow(/shard must look like/);
		expect(() => parseShard("")).toThrow(/shard must look like/);
	});

	it("formatShard 与 parseShard 互逆", () => {
		expect(formatShard(parseShard("2/5"))).toBe("2/5");
	});
});

describe("applyShard", () => {
	const items = ["a", "b", "c", "d", "e", "f", "g"];

	it("不分片时原样返回（且是副本）", () => {
		const result = applyShard(items);
		expect(result).toEqual(items);
		expect(result).not.toBe(items);
	});

	it("所有分片拼起来不重不漏地覆盖全集", () => {
		const collected: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			collected.push(...applyShard(items, { index, count: 3 }));
		}
		expect(collected.sort()).toEqual([...items].sort());
		expect(new Set(collected).size).toBe(items.length);
	});

	it("交错取片：分片内的相对顺序与全集一致", () => {
		expect(applyShard(items, { index: 0, count: 3 })).toEqual(["a", "d", "g"]);
		expect(applyShard(items, { index: 1, count: 3 })).toEqual(["b", "e"]);
		expect(applyShard(items, { index: 2, count: 3 })).toEqual(["c", "f"]);
	});

	it("count=1 等价于不分片", () => {
		expect(applyShard(items, { index: 0, count: 1 })).toEqual(items);
	});

	it("分片数超过题数时，后面的分片为空而不是报错", () => {
		expect(applyShard(["a"], { index: 4, count: 5 })).toEqual([]);
	});
});
