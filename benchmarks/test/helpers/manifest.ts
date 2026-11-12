// 测试用运行清单构造器：让报告测试不必关心 git/模型解析，只专注聚合口径。
// 与真实路径共用 createRunManifest/finalizeRunManifest，避免测试和实现各写一套形状。

import type { ModelTier } from "@hotpot/core";
import {
	type AgentFacts,
	type BenchmarkSuite,
	createRunManifest,
	finalizeRunManifest,
	type ManifestSelection,
	type ModelFingerprint,
	type RunManifest,
} from "../../src/manifest.ts";
import {
	BENCHMARK_RUNTIME,
	type BenchmarkRuntime,
} from "../../src/runtime-profile.ts";

export const TEST_AGENT_FACTS: AgentFacts = {
	packageVersion: "0.0.0-test",
	git: { commit: "deadbeef", dirty: false },
	node: "v22.0.0",
	platform: "test",
};

export const TEST_MODELS: Record<ModelTier, ModelFingerprint> = {
	high: {
		provider: "test",
		model: "test-high",
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
};

export interface MakeManifestOptions {
	suite?: BenchmarkSuite;
	agent?: AgentFacts;
	models?: Record<ModelTier, ModelFingerprint>;
	mainAgentTier?: ModelTier;
	runtime?: BenchmarkRuntime;
	// 每个实例的尝试次数；缺省不写字段（等价于 1）
	repeat?: number;
	selection?: Partial<ManifestSelection>;
	status?: "running" | "completed" | "failed";
}

export function makeManifest(opts: MakeManifestOptions = {}): RunManifest {
	const manifest = createRunManifest({
		runId: "bench-test",
		suite: opts.suite ?? "custom",
		startedAt: "2026-11-11T00:00:00.000Z",
		agent: opts.agent ?? TEST_AGENT_FACTS,
		models: opts.models ?? TEST_MODELS,
		mainAgentTier: opts.mainAgentTier ?? "high",
		runtime: opts.runtime ?? BENCHMARK_RUNTIME,
		...(opts.repeat === undefined ? {} : { repeat: opts.repeat }),
		selection: {
			count: 0,
			idsHash: "ids-hash",
			...opts.selection,
		},
	});
	const status = opts.status ?? "completed";
	if (status === "running") {
		return manifest;
	}
	return finalizeRunManifest(manifest, {
		status,
		finishedAt: "2026-11-11T00:10:00.000Z",
		durationMs: 600000,
	});
}
