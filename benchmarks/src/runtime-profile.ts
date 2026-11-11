// benchmark 运行档（runtime profile）：把「这次跑批实际用了什么装配」变成显式数据。
// 之前这些值以字面量散在 agent-runner 里（features 全关、maxParallelTasks=1、plan 自动批准、
// allow-all），报告侧完全看不到。两次跑批若装配不同却都只写一个通过率，数字就不可比。
// 这里只描述 benchmark 侧可控的装配，不含任何凭证；模型指纹由 manifest 从 settings 投影。

import type { Settings } from "@hotpot/core";

export interface FeatureFlags {
	todo: boolean;
	hooks: boolean;
	skills: boolean;
	promptTemplates: boolean;
	webSearch: boolean;
	webFetch: boolean;
	mcp: boolean;
}

export interface BenchmarkRuntime {
	// 供人读与差异比较的标识；改变装配时必须换 label，否则报告会看起来「同档」
	label: string;
	features: FeatureFlags;
	maxParallelTasks: number;
	planAutoApprove: boolean;
	// benchmark 要求零打断：审批链头显式 allow-all，并把 asked/decided 落盘
	permission: "allow-all";
	timeoutMs: number;
	// 只改工作树、不装依赖、不跑仓库测试：由它决定是否追加 prompt 约束，报告里的 patch-only 也取自这里
	patchOnly: boolean;
}

export const DEFAULT_BENCH_TIMEOUT_MS = 600000;

// 现状基线：单 agent 直通，关闭全部 M4/M5 特性，串行执行。
// 能力覆盖（路由/plan/并行/审批/skill）要等 profile 矩阵，见 docs/eval-system-plan.md P4。
export const BENCHMARK_RUNTIME: BenchmarkRuntime = {
	label: "baseline",
	features: {
		todo: false,
		hooks: false,
		skills: false,
		promptTemplates: false,
		webSearch: false,
		webFetch: false,
		mcp: false,
	},
	maxParallelTasks: 1,
	planAutoApprove: true,
	permission: "allow-all",
	timeoutMs: DEFAULT_BENCH_TIMEOUT_MS,
	patchOnly: true,
};

// 把运行档投影成 createRuntime 接受的 features 形状（结构一致，全部显式 boolean）
export function runtimeFeatures(
	runtime: BenchmarkRuntime,
): Settings["features"] {
	return { ...runtime.features };
}
