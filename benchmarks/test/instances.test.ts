// 实例切片测试：JSONL 解析、limit / 显式 id / 固定 seed 的确定性，
// 以及未知 id 的明确报错。fixture 与官方导出的字段形状保持一致。

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadInstances, selectInstances } from "../src/swebench/instances.ts";

const FIXTURE = join(process.cwd(), "benchmarks/test/fixtures/instances.jsonl");

describe("loadInstances", () => {
	it("逐行解析七个必需字段", async () => {
		const instances = await loadInstances(FIXTURE);
		expect(instances).toHaveLength(5);
		expect(instances[0]).toMatchObject({
			instance_id: "django__django-11099",
			repo: "django/django",
			version: "4.0",
		});
		expect(Array.isArray(instances[0]?.FAIL_TO_PASS)).toBe(true);
		expect(Array.isArray(instances[0]?.PASS_TO_PASS)).toBe(true);
	});
});

describe("selectInstances", () => {
	it("limit 与 seed 决定同一子集", async () => {
		const instances = await loadInstances(FIXTURE);
		const first = selectInstances(instances, { limit: 2, seed: 7 });
		const second = selectInstances(instances, { limit: 2, seed: 7 });
		expect(first).toHaveLength(2);
		expect(first.map((instance) => instance.instance_id)).toEqual(
			second.map((instance) => instance.instance_id),
		);
	});

	it("显式 instanceIds 按请求顺序返回", async () => {
		const instances = await loadInstances(FIXTURE);
		const selected = selectInstances(instances, {
			instanceIds: ["pytest-dev__pytest-7432", "django__django-11099"],
		});
		expect(selected.map((instance) => instance.instance_id)).toEqual([
			"pytest-dev__pytest-7432",
			"django__django-11099",
		]);
	});

	it("未知 instance id 抛出带 id 的错误", async () => {
		const instances = await loadInstances(FIXTURE);
		expect(() =>
			selectInstances(instances, { instanceIds: ["missing__repo-1"] }),
		).toThrow(/missing__repo-1/);
	});

	it("显式 ids 也遵守 limit", async () => {
		const instances = await loadInstances(FIXTURE);
		const selected = selectInstances(instances, {
			instanceIds: ["django__django-11099", "pytest-dev__pytest-7432"],
			limit: 1,
		});
		expect(selected.map((instance) => instance.instance_id)).toEqual([
			"django__django-11099",
		]);
	});
});
