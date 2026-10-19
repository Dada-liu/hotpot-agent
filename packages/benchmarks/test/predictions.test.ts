// 预测文件格式测试：官方 harness 只认 instance_id / model_name_or_path / model_patch
// 三个键；空 patch 必须保留为空字符串（表示 agent 没有产出，由 harness 记为 unresolved）。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePredictions } from "../src/swebench/predictions.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-bench-predictions-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("writePredictions", () => {
	it("输出逐行 JSON，键名与官方格式一致，空 patch 保留空串", async () => {
		const file = join(dir, "nested", "predictions.jsonl");
		await writePredictions(file, [
			{
				instanceId: "django__django-11099",
				patch: "diff --git a/x b/x\n+1\n",
			},
			{ instanceId: "pytest-dev__pytest-7432", patch: "" },
		]);

		const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		expect(Object.keys(first).sort()).toEqual([
			"instance_id",
			"model_name_or_path",
			"model_patch",
		]);
		expect(first).toEqual({
			instance_id: "django__django-11099",
			model_name_or_path: "hotpot-agent",
			model_patch: "diff --git a/x b/x\n+1\n",
		});
		const second = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
		expect(second.model_patch).toBe("");
	});

	it("空条目时写出空文件", async () => {
		const file = join(dir, "predictions.jsonl");
		await writeFile(file, "old content\n", "utf8");
		await writePredictions(file, []);
		expect(await readFile(file, "utf8")).toBe("");
	});
});
