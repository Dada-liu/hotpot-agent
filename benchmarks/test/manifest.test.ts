// 运行清单测试：可比较性的判定依据必须只包含可比对的事实，
// 且不能把凭证、完整 baseUrl 或查询串写进报告目录。
// git 相关用例用临时仓库，不触网、不依赖外部工作区。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectAgentFacts,
	collectModelFingerprints,
	createRunManifest,
	describeManifestDiff,
	finalizeRunManifest,
	hashTaskSet,
	isComparable,
	manifestForComparison,
	readRunManifest,
	writeRunManifest,
} from "../src/index.ts";
import { runCommand } from "../src/process.ts";
import { BENCHMARK_RUNTIME } from "../src/runtime-profile.ts";
import {
	makeManifest,
	TEST_AGENT_FACTS,
	TEST_MODELS,
} from "./helpers/manifest.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-bench-manifest-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const MODELS: Settings["models"] = {
	high: {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		apiKey: "sk-secret-high",
	},
	medium: {
		provider: "openai",
		model: "gpt-4.1",
		apiKey: "sk-secret-medium",
		baseUrl: "https://api.example.com/v1?token=secret-query",
	},
	low: {
		provider: "deepseek",
		model: "deepseek-chat",
		apiKey: "sk-secret-low",
		baseUrl: "https://api.deepseek.com/v1",
	},
};

describe("collectModelFingerprints", () => {
	it("只保留 provider/model/host/path，不写密钥与查询串", () => {
		const models = collectModelFingerprints(MODELS);
		expect(models.high).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			baseUrlHost: null,
			baseUrlPath: null,
		});
		expect(models.medium).toEqual({
			provider: "openai",
			model: "gpt-4.1",
			baseUrlHost: "api.example.com",
			baseUrlPath: "/v1",
		});

		const serialized = JSON.stringify(models);
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("token=secret-query");
		expect(serialized).not.toContain("apiKey");
	});

	it("同一 host 不同 path 仍算不同指纹", () => {
		const a = collectModelFingerprints({
			...MODELS,
			low: { ...MODELS.low, baseUrl: "https://api.example.com/coding/v1" },
		});
		const b = collectModelFingerprints({
			...MODELS,
			low: { ...MODELS.low, baseUrl: "https://api.example.com/v1" },
		});
		expect(a.low.baseUrlHost).toBe(b.low.baseUrlHost);
		expect(a.low.baseUrlPath).not.toBe(b.low.baseUrlPath);
	});

	it("非法 baseUrl 记成标记，不原样落盘", () => {
		const models = collectModelFingerprints({
			...MODELS,
			low: { ...MODELS.low, baseUrl: "api.deepseek.com/v1" },
		});
		expect(models.low.baseUrlHost).toBe("<invalid>");
	});
});

describe("describeManifestDiff", () => {
	it("同条件的两次跑批判定为可比", () => {
		const a = makeManifest();
		const b = makeManifest();
		expect(describeManifestDiff(a, b)).toEqual([]);
		expect(isComparable(a, b)).toBe(true);
	});

	it("模型、commit、运行档、题目集变化都会让两次跑批不可比", () => {
		const base = makeManifest();

		const modelChanged = makeManifest({
			models: {
				...TEST_MODELS,
				high: { ...TEST_MODELS.high, model: "other-high" },
			},
		});
		expect(describeManifestDiff(base, modelChanged)).toEqual([
			'model tier high: {"provider":"test","model":"test-high","baseUrlHost":null,"baseUrlPath":null} -> {"provider":"test","model":"other-high","baseUrlHost":null,"baseUrlPath":null}',
		]);

		const commitChanged = makeManifest({
			agent: { ...TEST_AGENT_FACTS, git: { commit: "cafe1234", dirty: true } },
		});
		expect(describeManifestDiff(base, commitChanged).join("\n")).toContain(
			"git commit",
		);

		const runtimeChanged = makeManifest({
			runtime: { ...BENCHMARK_RUNTIME, maxParallelTasks: 3 },
		});
		expect(describeManifestDiff(base, runtimeChanged).join("\n")).toContain(
			"runtime profile",
		);

		const selectionChanged = makeManifest({
			selection: { count: 1, idsHash: "other-hash" },
		});
		expect(describeManifestDiff(base, selectionChanged)).toEqual([
			"selected instances: ids-hash -> other-hash",
		]);
	});
});

describe("writeRunManifest / readRunManifest", () => {
	it("落盘后可按 schema 读回", async () => {
		const manifest = makeManifest({ selection: { count: 3 } });
		const path = await writeRunManifest(manifest, dir);
		const read = await readRunManifest(path);
		expect(read).toEqual(manifest);
	});

	it("schemaVersion 不支持时报错，而不是把旧格式当成新格式", async () => {
		const path = join(dir, "manifest.json");
		await writeFile(path, '{ "schemaVersion": 99 }\n');
		await expect(readRunManifest(path)).rejects.toThrow(/schemaVersion 1/);
	});

	it("finalize 写入状态、结束时间与总耗时", () => {
		const running = createRunManifest({
			runId: "r",
			suite: "custom",
			startedAt: "2026-11-11T00:00:00.000Z",
			agent: TEST_AGENT_FACTS,
			models: TEST_MODELS,
			mainAgentTier: "high",
			runtime: BENCHMARK_RUNTIME,
			selection: { count: 0, idsHash: "x" },
		});
		expect(running.status).toBe("running");
		const done = finalizeRunManifest(running, {
			status: "completed",
			finishedAt: "2026-11-11T00:01:00.000Z",
			durationMs: 60000,
		});
		expect(done.status).toBe("completed");
		expect(done.durationMs).toBe(60000);
		// 原始对象不被改写：running 版本可能已经落盘
		expect(running.status).toBe("running");
	});
});

describe("hashTaskSet", () => {
	it("键顺序不影响哈希，题面改动会改变哈希", () => {
		const a = {
			id: "t1",
			prompt: "do it",
			validation: { command: "node check.mjs" },
		};
		const b = {
			validation: { command: "node check.mjs" },
			prompt: "do it",
			id: "t1",
		};
		expect(hashTaskSet([a])).toBe(hashTaskSet([b]));

		const changed = { ...a, prompt: "do it twice" };
		expect(hashTaskSet([a])).not.toBe(hashTaskSet([changed]));
	});

	it("题目顺序不影响哈希", () => {
		const one = { id: "a" };
		const two = { id: "b" };
		expect(hashTaskSet([one, two])).toBe(hashTaskSet([two, one]));
	});
});

describe("collectAgentFacts", () => {
	it("取不到 git 事实时记 null，而不是伪造一个 commit", async () => {
		const facts = await collectAgentFacts(dir);
		expect(facts.node).toBe(process.version);
		// 临时目录不是 git 仓库：commit 与 dirty 都是 null（未知），不是「干净」
		expect(facts.git).toEqual({ commit: null, dirty: null });
		expect(facts.packageVersion.length).toBeGreaterThan(0);
	});

	it("工作树有未提交改动时标记 dirty", async () => {
		const init = await runCommand("git", ["init"], {
			cwd: dir,
			timeoutMs: 10000,
		});
		expect(init.code).toBe(0);
		const clean = await collectAgentFacts(dir);
		expect(clean.git.dirty).toBe(false);
		// 空仓库没有 HEAD：commit 记 null
		expect(clean.git.commit).toBeNull();

		await writeFile(join(dir, "new-file.txt"), "x\n");
		const dirty = await collectAgentFacts(dir);
		expect(dirty.git.dirty).toBe(true);
	});
});

describe("report 内嵌的 manifest", () => {
	it("manifest 与 report 一起落盘，密钥不出现在任何文件里", async () => {
		const manifest = makeManifest({
			models: collectModelFingerprints(MODELS),
		});
		const path = await writeRunManifest(manifest, dir);
		const text = await readFile(path, "utf8");
		expect(text).toContain("api.example.com");
		expect(text).not.toContain("sk-secret");
		expect(text).not.toContain("secret-query");
	});
});

describe("manifestForComparison", () => {
	// 分片各自只跑了一部分题，idsHash 必然不同；
	// 能不能合并只看 parentIdsHash —— 这是 merge 的唯一判据。
	const shard = (index: number, idsHash: string, parentIdsHash: string) =>
		makeManifest({
			suite: "swebench",
			selection: {
				dataset: "SWE-bench/SWE-bench_Lite",
				split: "test",
				count: 2,
				idsHash,
				shard: { index, count: 2 },
				parentIdsHash,
				parentCount: 4,
			},
		});

	it("共享父集合的分片被判定为可比", () => {
		const a = shard(0, "hash-a", "parent-1");
		const b = shard(1, "hash-b", "parent-1");
		expect(describeManifestDiff(a, b)).not.toHaveLength(0);
		expect(
			describeManifestDiff(manifestForComparison(a), manifestForComparison(b)),
		).toHaveLength(0);
	});

	it("父集合不同的分片不可比", () => {
		const a = shard(0, "hash-a", "parent-1");
		const b = shard(1, "hash-b", "parent-2");
		expect(
			describeManifestDiff(manifestForComparison(a), manifestForComparison(b)),
		).toHaveLength(1);
	});

	it("非分片运行的清单原样返回", () => {
		const plain = makeManifest({ selection: { count: 1, idsHash: "h" } });
		expect(manifestForComparison(plain)).toBe(plain);
	});
});
