// 两组跑批的对比：先验「能不能比」，再算「差多少」。
//
// 判定只用一条规则：差异必须超过「同一份代码自己跑 k 次」的波动幅度，否则就是 inconclusive。
// 这不是显著性检验（配对 McNemar 还没做），所以结论字段叫 better/worse 而不是 ship：
// 它回答「方向对不对」，不回答「能不能上线」。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	describeManifestDiff,
	MANIFEST_FILE,
	type RunManifest,
	readRunManifest,
} from "../manifest.ts";
import { type BenchmarkReport, REPORT_FILE } from "../report.ts";
import type {
	ComparisonVerdict,
	ExperimentComparison,
	ExperimentRun,
} from "./types.ts";

export interface RunArtifacts {
	dir: string;
	manifest: RunManifest;
	report: BenchmarkReport;
}

export async function readRunArtifacts(dir: string): Promise<RunArtifacts> {
	const manifestPath = join(dir, MANIFEST_FILE);
	const reportPath = join(dir, REPORT_FILE);
	const manifest = await readRunManifest(manifestPath);
	let report: BenchmarkReport;
	try {
		report = JSON.parse(await readFile(reportPath, "utf8")) as BenchmarkReport;
	} catch (err) {
		throw new Error(
			`${reportPath}: 读不到跑批报告（${err instanceof Error ? err.message : String(err)}）`,
		);
	}
	if (!Array.isArray(report.instances) || !Array.isArray(report.perInstance)) {
		throw new Error(`${reportPath}: 不是本仓库 bench 产出的报告`);
	}
	return { dir, manifest, report };
}

export interface ValidationResult {
	errors: string[];
	warnings: string[];
}

export interface ValidateRunInput {
	variant: "base" | "head";
	baseCommit: string;
	repeat: number;
	artifacts: RunArtifacts;
	// 候选 worktree 当前的 HEAD；worktree 已回收时缺省
	headCommit?: string;
	// 另一变体已登记的跑批：条件必须与它一致，否则比的是两件事
	other?: RunArtifacts;
}

export function validateRun(input: ValidateRunInput): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const { manifest } = input.artifacts;

	if (manifest.status !== "completed") {
		errors.push(
			`manifest.status = ${manifest.status}：跑批没有走完，这份结果不能用于结论`,
		);
	}
	const dirty = manifest.agent.git.dirty;
	if (dirty === true) {
		errors.push(
			"跑批时工作区不干净（manifest.git.dirty = true）：这份结果无法复现，换一个干净的 worktree 重跑",
		);
	} else if (dirty === null) {
		warnings.push("manifest 取不到 git 状态：无法确认跑批时工作区是否干净");
	}

	const commit = manifest.agent.git.commit;
	if (input.variant === "base") {
		if (commit !== input.baseCommit) {
			errors.push(
				`base 跑批的提交是 ${commit ?? "unknown"}，台账记录的基线是 ${input.baseCommit}：基线已经漂移，这份结果不是「改动前」`,
			);
		}
	} else if (input.headCommit !== undefined && commit !== input.headCommit) {
		errors.push(
			`head 跑批的提交是 ${commit ?? "unknown"}，worktree 当前 HEAD 是 ${input.headCommit}：跑完之后又改过代码，重跑一遍再登记`,
		);
	}

	const repeat = manifest.repeat ?? 1;
	if (repeat !== input.repeat) {
		errors.push(
			`这次跑了 ${repeat} 次尝试，台账记录的是 ${input.repeat}：重复次数属于实验条件，不能混着比`,
		);
	}
	if (repeat < 2) {
		warnings.push("只有 1 次尝试：没有误差棒，对比只能给 inconclusive");
	} else if (repeat < 3) {
		warnings.push("只有 2 次尝试：极差本身也很随机，判定门槛偏松");
	}

	if (input.other !== undefined) {
		const diffs = describeManifestDiff(input.other.manifest, manifest, {
			ignoreIdentity: true,
		});
		if (diffs.length > 0) {
			errors.push(
				`与另一变体的跑批条件不一致，不能对比：\n  ${diffs.join("\n  ")}`,
			);
		}
	}

	return { errors, warnings };
}

export function toExperimentRun(
	artifacts: RunArtifacts,
	variant: "base" | "head",
	suite: string,
	now: string,
): ExperimentRun {
	const { manifest, report } = artifacts;
	return {
		variant,
		runId: manifest.runId,
		dir: artifacts.dir,
		manifestPath: join(artifacts.dir, MANIFEST_FILE),
		reportPath: join(artifacts.dir, REPORT_FILE),
		commit: manifest.agent.git.commit,
		commitDirty: manifest.agent.git.dirty,
		suite,
		repeat: report.repeat.attempts,
		passed: report.passed,
		total: report.total,
		passRate: report.passRate,
		passRateByAttempt: report.repeat.passRateByAttempt,
		passRateMin: report.repeat.passRateMin,
		passRateMax: report.repeat.passRateMax,
		tokensPerResolved: report.tokensPerResolved,
		recordedAt: now,
	};
}

export function compareRuns(
	base: RunArtifacts,
	head: RunArtifacts,
	now: string,
): ExperimentComparison {
	const baseReport = base.report;
	const headReport = head.report;
	if (baseReport.total === 0 || headReport.total === 0) {
		throw new Error("有一侧没有跑出任何题，无法对比");
	}

	const baseIds = new Set(
		baseReport.perInstance.map((item) => item.instanceId),
	);
	const headIds = new Set(
		headReport.perInstance.map((item) => item.instanceId),
	);
	const onlyBase = [...baseIds].filter((id) => !headIds.has(id));
	const onlyHead = [...headIds].filter((id) => !baseIds.has(id));
	if (onlyBase.length > 0 || onlyHead.length > 0) {
		throw new Error(
			`两侧题目集合不同，无法按题配对（仅 base ${onlyBase.length} 题，仅 head ${onlyHead.length} 题）`,
		);
	}

	const deltaPp = (headReport.passRate - baseReport.passRate) * 100;
	// 判定阈值 = max(两组各自的极差, 单题刻度)。单题刻度防的是「10 题套件上多对 1 题」
	// 被当成 10pp 的改进：那只是换了一道题，不是能力变化。
	const spreadPp = Math.max(
		(baseReport.repeat.passRateMax - baseReport.repeat.passRateMin) * 100,
		(headReport.repeat.passRateMax - headReport.repeat.passRateMin) * 100,
	);
	const minEffectPp = 100 / Math.max(baseReport.total, 1);
	const noisePp = Math.max(spreadPp, minEffectPp);

	const reasons: string[] = [];
	let verdict: ComparisonVerdict;
	const minAttempts = Math.min(
		baseReport.repeat.attempts,
		headReport.repeat.attempts,
	);
	if (minAttempts < 2) {
		verdict = "inconclusive";
		reasons.push(
			"至少一侧只有 1 次尝试，没有「同一版本自己跑」的波动幅度可用，任何差异都无法与噪声区分",
		);
	} else if (Math.abs(deltaPp) <= noisePp) {
		verdict = "inconclusive";
		reasons.push(
			`差异 ${deltaPp.toFixed(1)}pp 没有超过判定阈值 ${noisePp.toFixed(1)}pp（自身极差 ${spreadPp.toFixed(1)}pp，单题刻度 ${minEffectPp.toFixed(1)}pp）`,
		);
	} else {
		verdict = deltaPp > 0 ? "better" : "worse";
		reasons.push(
			`差异 ${deltaPp.toFixed(1)}pp 超过判定阈值 ${noisePp.toFixed(1)}pp（自身极差 ${spreadPp.toFixed(1)}pp，单题刻度 ${minEffectPp.toFixed(1)}pp）`,
		);
	}
	if (sampleSmall(baseReport.total)) {
		reasons.push(
			`题量 ${baseReport.total}：单题即 ${minEffectPp.toFixed(1)}pp，只能排除明显变差，不能证明小幅改进`,
		);
	}
	reasons.push(
		"判定方法是「差异 vs 自身极差」，不是配对显著性检验；逐题翻转只作为方向参考",
	);

	const baseById = new Map(
		baseReport.perInstance.map((item) => [item.instanceId, item]),
	);
	const perInstance = headReport.perInstance
		.map((item) => {
			const baseItem = baseById.get(item.instanceId);
			return {
				instanceId: item.instanceId,
				basePassed: baseItem?.passed ?? 0,
				headPassed: item.passed,
				attempts: Math.min(item.attempts, baseItem?.attempts ?? item.attempts),
			};
		})
		.sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));

	const improved = perInstance.filter(
		(item) => item.headPassed > item.basePassed,
	).length;
	const regressed = perInstance.filter(
		(item) => item.headPassed < item.basePassed,
	).length;
	const unchanged = perInstance.length - improved - regressed;

	const costDeltaPct =
		baseReport.tokensPerResolved === null ||
		headReport.tokensPerResolved === null
			? null
			: ((headReport.tokensPerResolved - baseReport.tokensPerResolved) /
					baseReport.tokensPerResolved) *
				100;

	return {
		verdict,
		deltaPp,
		noisePp,
		method: "spread",
		reasons,
		perInstance,
		improved,
		regressed,
		unchanged,
		costDeltaPct,
		comparedAt: now,
	};
}

// 30 题以下：单题权重 3.3pp 以上，方向可信但幅度不可信
function sampleSmall(total: number): boolean {
	return total < 30;
}
