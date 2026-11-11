// 合并的底线：拼出来的「一轮」必须能对得上实验条件、不重复计题、且诚实标注是否跑完。
// 三条里任何一条松掉，passRate 都会变成一个看着像真的错误数字。

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashStrings } from "../src/manifest.ts";
import {
	mergeArtifacts,
	mergeRunDirs,
	type RunArtifacts,
} from "../src/merge.ts";
import { buildReport, REPORT_FILE } from "../src/report.ts";
import {
	PREDICTIONS_FILE,
	writePredictions,
} from "../src/swebench/predictions.ts";
import { makeManifest } from "./helpers/manifest.ts";

const PARENT_HASH = hashStrings(["a", "b", "c", "d"]);

interface MakeArtifactOptions {
	shardIndex?: number;
	shardCount?: number;
	passed?: readonly string[];
	// 覆盖 manifest 里的某个字段，用来构造「不可比」的场景
	models?: NonNullable<Parameters<typeof makeManifest>[0]>["models"];
	status?: "running" | "completed";
}

function makeArtifact(
	dir: string,
	ids: readonly string[],
	opts: MakeArtifactOptions = {},
): RunArtifacts {
	const manifest = makeManifest({
		suite: "swebench",
		...(opts.status === undefined ? {} : { status: opts.status }),
		...(opts.models === undefined ? {} : { models: opts.models }),
		selection: {
			dataset: "SWE-bench/SWE-bench_Lite",
			split: "test",
			count: ids.length,
			idsHash: hashStrings(ids),
			shard: { index: opts.shardIndex ?? 0, count: opts.shardCount ?? 2 },
			parentIdsHash: PARENT_HASH,
			parentCount: 4,
		},
	});
	const passedSet = new Set(opts.passed ?? []);
	const results = ids.map((id) => ({
		instanceId: id,
		passed: passedSet.has(id),
		durationMs: 1000,
		inputTokens: 100,
		outputTokens: 10,
	}));
	const report = buildReport(
		results,
		{
			runId: manifest.runId,
			resolved: results.filter((r) => r.passed).map((r) => r.instanceId),
			unresolved: results.filter((r) => !r.passed).map((r) => r.instanceId),
			emptyPatch: [],
		},
		{
			suite: "swebench",
			dataset: "SWE-bench/SWE-bench_Lite",
			split: "test",
			manifest,
		},
	);
	return {
		dir,
		manifest,
		report,
		predictions: ids.map((id) => ({ instanceId: id, patch: `diff-${id}` })),
	};
}

describe("mergeArtifacts", () => {
	it("两个分片合成一轮：题数、通过数、id 集合都对得上", () => {
		const first = makeArtifact("runs/shard-1", ["a", "b"], {
			shardIndex: 0,
			passed: ["a"],
		});
		const second = makeArtifact("runs/shard-2", ["c", "d"], {
			shardIndex: 1,
			passed: ["c", "d"],
		});

		const { report, predictions } = mergeArtifacts([first, second], {
			runId: "merged-1",
		});

		expect(report.total).toBe(4);
		expect(report.passed).toBe(3);
		expect(report.passRate).toBe(0.75);
		expect(report.instances.map((i) => i.instanceId)).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
		expect(predictions.map((p) => p.instanceId)).toEqual(["a", "b", "c", "d"]);
		// 合并后的清单是「父集合」视角：不再有 shard 字段，idsHash 覆盖全集
		expect(report.manifest.selection.shard).toBeUndefined();
		expect(report.manifest.selection.parentIdsHash).toBeUndefined();
		expect(report.manifest.selection.idsHash).toBe(PARENT_HASH);
		expect(report.manifest.selection.count).toBe(4);
		expect(report.manifest.runId).toBe("merged-1");
		expect(report.manifest.status).toBe("completed");
	});

	it("拒绝实验条件不同的分片", () => {
		const first = makeArtifact("runs/a", ["a", "b"]);
		const second = makeArtifact("runs/b", ["c", "d"], {
			models: {
				high: {
					provider: "other",
					model: "other-high",
					baseUrlHost: null,
					baseUrlPath: null,
				},
				medium: {
					provider: "test",
					model: "test-medium",
					baseUrlHost: null,
					baseUrlPath: null,
				},
				low: {
					provider: "test",
					model: "test-low",
					baseUrlHost: null,
					baseUrlPath: null,
				},
			},
		});
		expect(() =>
			mergeArtifacts([first, second], { runId: "merged-x" }),
		).toThrow(/不可合并[\s\S]*model tier high/);
	});

	it("拒绝父集合不同的分片（不同批次的题不能拼成一轮）", () => {
		const first = makeArtifact("runs/a", ["a", "b"]);
		const second = makeArtifact("runs/b", ["c", "d"]);
		const foreign = {
			...second,
			manifest: {
				...second.manifest,
				selection: {
					...second.manifest.selection,
					parentIdsHash: hashStrings(["x", "y", "z", "w"]),
				},
			},
		};
		expect(() =>
			mergeArtifacts([first, foreign], { runId: "merged-y" }),
		).toThrow(/不可合并[\s\S]*selected instances/);
	});

	it("拒绝重叠实例：同一题跑两次会把 passRate 抬高", () => {
		const first = makeArtifact("runs/a", ["a", "b"]);
		const second = makeArtifact("runs/b", ["b", "c"]);
		expect(() =>
			mergeArtifacts([first, second], { runId: "merged-z" }),
		).toThrow(/同时出现在[\s\S]*分片重叠/);
	});

	it("有分片没跑完时，合并结果标记为 running", () => {
		const first = makeArtifact("runs/a", ["a", "b"]);
		const second = makeArtifact("runs/b", ["c", "d"], { status: "running" });
		const { report } = mergeArtifacts([first, second], { runId: "merged-p" });
		expect(report.manifest.status).toBe("running");
		expect(report.manifest.finishedAt).toBeUndefined();
	});
});

describe("mergeRunDirs", () => {
	it("从磁盘读分片目录并写出合并产物", async () => {
		const root = await mkdtemp(join(tmpdir(), "bench-merge-"));
		const shardA = join(root, "shard-1");
		const shardB = join(root, "shard-2");
		for (const [dir, ids, passed] of [
			[shardA, ["a", "b"], ["a"]],
			[shardB, ["c", "d"], ["c"]],
		] as const) {
			const artifact = makeArtifact(dir, ids, { passed });
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "manifest.json"),
				`${JSON.stringify(artifact.manifest, null, 2)}\n`,
			);
			await writeFile(
				join(dir, REPORT_FILE),
				`${JSON.stringify(artifact.report, null, 2)}\n`,
			);
			await writePredictions(join(dir, PREDICTIONS_FILE), artifact.predictions);
		}

		const output = join(root, "merged");
		const { report, paths } = await mergeRunDirs([shardA, shardB], {
			outputDir: output,
			runId: "merged-disk",
		});
		expect(report.total).toBe(4);
		expect(report.passed).toBe(2);
		expect(paths.jsonPath).toBe(join(output, REPORT_FILE));
	});

	it("分片目录缺少 report 时给出可读的报错", async () => {
		const root = await mkdtemp(join(tmpdir(), "bench-merge-missing-"));
		const shard = join(root, "shard-1");
		await mkdir(shard, { recursive: true });
		const artifact = makeArtifact(shard, ["a"]);
		await writeFile(
			join(shard, "manifest.json"),
			`${JSON.stringify(artifact.manifest, null, 2)}\n`,
		);
		await expect(
			mergeRunDirs([shard], { outputDir: join(root, "out"), runId: "x" }),
		).rejects.toThrow(/report\.json not found/);
	});
});
