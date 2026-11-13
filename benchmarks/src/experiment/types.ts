// 实验台账的数据契约：一条记录 = 一个「功能需求 → worktree → 跑批 → 决策」的闭环。
//
// 为什么台账不放在 worktree 里：worktree 是临时的，跑完就删；实验记录要长期可查。
// 所以记录只写主工作区的 docs/experiments/，实验分支只装代码。这样「现在有几组实验在跑、
// 每组验证什么、结论是什么」永远只有一个地方能查，而不是散在 6 个分支里。
//
// 记录里同时存「实验条件」（baseCommit/suite/repeat）与「跑批事实」（runId/通过率/提交）：
// 前者决定两组跑批能不能比，后者是比出来的结果。两者混在一起而不分离，就会出现
// 「通过率看着涨了，但其实是模型档位换了」这种结论。

import type { ModelTier } from "@hotpot/core";

export const EXPERIMENT_SCHEMA_VERSION = 1;

// open：worktree 已建、结论未出；decided：人已判；closed：worktree 已回收（结论保留）
export type ExperimentStatus = "open" | "decided" | "closed";

// base = 改动前的代码（detached worktree，锁在 baseCommit）；
// head = 改动分支（exp/<slug>）
export type ExperimentVariant = "base" | "head";

export type ExperimentVerdict = "ship" | "no-ship" | "inconclusive";
export type ComparisonVerdict = "better" | "worse" | "inconclusive";

// 一轮跑批里与「实验结论」相关的事实。路径全用绝对路径：
// worktree 会被回收，产物不能跟着消失。
export interface ExperimentRun {
	variant: ExperimentVariant;
	runId: string;
	dir: string;
	// 清单路径单独存：登记另一变体时要读回它的条件做可比性判定，
	// 不能只靠台账里已聚合的数字（那已经丢了模型/运行档信息）
	manifestPath: string;
	reportPath: string;
	commit: string | null;
	commitDirty: boolean | null;
	suite: string;
	repeat: number;
	passed: number;
	total: number;
	// 尝试级平均通过率（report.passRate），不是「至少通过一次」的比例
	passRate: number;
	// 每轮尝试各自的通过率：它的极差就是「同一份代码自己跑 k 次」的波动幅度
	passRateByAttempt: number[];
	passRateMin: number;
	passRateMax: number;
	tokensPerResolved: number | null;
	recordedAt: string;
}

// 对比是「机械结论」，决策是「人的结论」。分开存，才能事后追责：
// 人可以推翻对比结果（例如为了稳定性接受 inconclusive），但推翻这个动作要留痕。
export interface ExperimentComparison {
	verdict: ComparisonVerdict;
	// 单位是百分点：head.passRate - base.passRate
	deltaPp: number;
	// 判定阈值：取「两组各自重复尝试的极差」与「单题刻度 100/题数」的大者。
	// 差异不超过它就是 inconclusive
	noisePp: number;
	// spread：只看差异是否超过自身波动。配对检验（McNemar）尚未实现，
	// 不要把这里的结论当成显著性检验
	method: "spread";
	reasons: string[];
	// 配对明细：同一题在两个版本上各通过几次
	perInstance: {
		instanceId: string;
		basePassed: number;
		headPassed: number;
		attempts: number;
	}[];
	improved: number;
	regressed: number;
	unchanged: number;
	// 每个通过题的 token 变化百分比；任一侧为 null 时为 null
	costDeltaPct: number | null;
	comparedAt: string;
}

export interface ExperimentDecision {
	verdict: ExperimentVerdict;
	note: string;
	at: string;
	// 决策当时的对比快照：之后重跑跑批不会改掉这条历史
	comparison?: ExperimentComparison;
}

// 远端遥测回读的快照：只存摘要，不存逐题明细（明细在 benchmark-runs/.../telemetry.json）。
// 存进台账是为了让「决策时有没有核对过远端数据」这件事可查，而不是让人再开一次网页。
export interface ExperimentTelemetryRun {
	variant: ExperimentVariant;
	runId: string;
	status: "ok" | "missing" | "mismatch";
	attempts: number | null;
	passed: number | null;
	passRate: number | null;
	resolvedInstances: number | null;
	flakyInstances: number | null;
	diffs: string[];
}

export interface ExperimentTelemetry {
	pulledAt: string;
	endpoint: string;
	window: { from: string; to: string };
	runs: ExperimentTelemetryRun[];
}

export interface ExperimentRecord {
	slug: string;
	title: string;
	status: ExperimentStatus;
	createdAt: string;
	updatedAt: string;
	branch: string;
	// 仓库相对路径（.worktrees/<slug>），换机器也能读懂
	worktree: string;
	// 基线 worktree；--no-base 时缺省
	baseWorktree?: string;
	baseRef: string;
	// 完整 sha：base 跑批的 manifest.commit 必须等于它，否则基线已经漂移
	baseCommit: string;
	suite: string;
	repeat: number;
	modelTier?: ModelTier;
	// 两个 worktree 共用同一份实例文件，避免「版本不同、题目也不同」
	instancesFile: string;
	requirement?: string;
	hypothesis: string;
	primaryMetric: string;
	guardrailMetric: string;
	rollback: string;
	runs: ExperimentRun[];
	comparison?: ExperimentComparison;
	telemetry?: ExperimentTelemetry;
	decision?: ExperimentDecision;
	closedAt?: string;
}

export interface ExperimentRegistry {
	schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
	// 按创建时间倒序：新实验在最上面，git diff 也只落在文件头部
	experiments: ExperimentRecord[];
}

export function emptyRegistry(): ExperimentRegistry {
	return { schemaVersion: EXPERIMENT_SCHEMA_VERSION, experiments: [] };
}

export function findExperiment(
	registry: ExperimentRegistry,
	slug: string,
): ExperimentRecord | undefined {
	return registry.experiments.find((record) => record.slug === slug);
}

export function findRun(
	record: ExperimentRecord,
	variant: ExperimentVariant,
): ExperimentRun | undefined {
	return record.runs.find((run) => run.variant === variant);
}
