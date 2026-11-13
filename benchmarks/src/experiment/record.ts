// 登记一轮跑批：CLI 的 `exp record` 与 `exp run` 跑完后的自动登记共用这一份实现。
//
// 独立成模块的原因：登记不是「把数字写进台账」，而是一组判定（跑批是否走完、
// 工作区是否干净、提交是否对得上、两轮条件是否可比）。如果 run 自己拼一份简化版，
// 自动跑批就会绕过这些判定，产出一条看起来完整但不可信的结论。

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	compareRuns,
	type RunArtifacts,
	readRunArtifacts,
	toExperimentRun,
	validateRun,
} from "./compare.ts";
import { worktreeState } from "./git.ts";
import { experimentPaths, saveExperiment } from "./ledger.ts";
import type {
	ExperimentRecord,
	ExperimentRegistry,
	ExperimentRun,
	ExperimentVariant,
} from "./types.ts";

export interface RecordLogger {
	out: (line: string) => void;
	err: (line: string) => void;
}

export interface RegisterRunInput {
	mainRoot: string;
	cwd: string;
	registry: ExperimentRegistry;
	record: ExperimentRecord;
	variant: ExperimentVariant;
	runDir?: string;
	force?: boolean;
	// 编排重跑时第一次登记用：忽略台账里残留的「旧另一变体」，
	// 否则旧产物的实验条件会让本次 base 直接被判为不可比
	ignoreOther?: boolean;
	now: () => Date;
	log: RecordLogger;
}

export interface RegisterRunResult {
	code: number;
	registry: ExperimentRegistry;
	record: ExperimentRecord;
}

export async function registerRun(
	input: RegisterRunInput,
): Promise<RegisterRunResult> {
	const { log } = input;
	const repo = { mainRoot: input.mainRoot };
	const registry = input.registry;
	const record = input.record;
	const command = {
		slug: record.slug,
		variant: input.variant,
		runDir: input.runDir,
		force: input.force ?? false,
	};
	if (
		record.decision !== undefined &&
		record.decision.verdict !== "inconclusive" &&
		!command.force
	) {
		throw new Error(
			`实验已决策（${record.decision.verdict}）：证据已经定稿，追加跑批会改写结论的依据。\n确实要覆盖请加 --force（决策会被丢弃），或新开一个实验`,
		);
	}
	const paths = experimentPaths(repo.mainRoot, record.slug);
	const runDir =
		command.runDir === undefined
			? join(paths.runsRoot, command.variant)
			: resolve(input.cwd, command.runDir);
	const artifacts = await readRunArtifacts(runDir);

	const headPath = join(repo.mainRoot, record.worktree);
	const headState = existsSync(headPath)
		? await worktreeState(headPath)
		: undefined;
	const otherEntry =
		input.ignoreOther === true
			? undefined
			: record.runs.find((item) => item.variant !== command.variant);
	let other: RunArtifacts | undefined;
	const warnings: string[] = [];
	if (otherEntry !== undefined) {
		try {
			other = await readRunArtifacts(otherEntry.dir);
		} catch (err) {
			warnings.push(
				`另一变体的跑批目录已不可读，跳过条件比对：${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	const validation = validateRun({
		variant: command.variant,
		baseCommit: record.baseCommit,
		repeat: record.repeat,
		artifacts,
		...(headState?.commit == null ? {} : { headCommit: headState.commit }),
		...(other === undefined ? {} : { other }),
	});
	if (validation.errors.length > 0) {
		log.err(`拒绝登记 ${command.slug} 的 ${command.variant} 跑批：`);
		for (const error of validation.errors) {
			log.err(`  - ${error}`);
		}
		return { code: 1, registry, record };
	}
	for (const warning of [...validation.warnings, ...warnings]) {
		log.err(`warning: ${warning}`);
	}

	const now = input.now().toISOString();
	const run = toExperimentRun(artifacts, command.variant, record.suite, now);
	const runs: ExperimentRun[] = [
		...record.runs.filter((item) => item.variant !== command.variant),
		run,
	];
	const base = command.variant === "base" ? artifacts : other;
	const head = command.variant === "head" ? artifacts : other;
	const comparison =
		base !== undefined && head !== undefined
			? compareRuns(base, head, now)
			: undefined;

	const next: ExperimentRecord = {
		...record,
		runs,
		updatedAt: now,
		// 证据变了，旧决策就不再成立：inconclusive 可以就地重跑，
		// ship/no-ship 要走 --force 并显式丢弃
		status: record.decision === undefined ? record.status : "open",
	};
	// 两轮不齐时不能留着上一轮的对比：那会让人以为结论还对应当前证据
	if (comparison === undefined) {
		delete next.comparison;
	} else {
		next.comparison = comparison;
	}
	// 跑批变了，之前拉回的远端快照就过期了：重新 pnpm exp pull
	delete next.telemetry;
	if (command.force && next.decision !== undefined) {
		delete next.decision;
	}
	if (next.status === "closed") {
		next.status = "open";
	}
	const saved = await saveExperiment(repo.mainRoot, registry, next);

	log.out(
		`已登记 ${command.slug} 的 ${command.variant}：${short(run.runId)}  ${formatRun(run)}  每轮 ${run.passRateByAttempt.map((value) => pct(value)).join(" / ")}`,
	);
	log.out(`  目录 ${run.dir}`);
	if (next.decision === undefined && record.decision !== undefined) {
		log.out("  已丢弃原决策：证据变了，结论要重新判");
	}
	if (comparison === undefined) {
		const missing = command.variant === "base" ? "head" : "base";
		log.out(
			`  另一变体尚未登记：pnpm exp record ${command.slug} --variant ${missing}`,
		);
		return { code: 0, registry: saved, record: next };
	}
	log.out("");
	log.out(
		`对比：${comparison.verdict}  差异 ${signed(comparison.deltaPp)}pp  阈值 ${comparison.noisePp.toFixed(1)}pp  翻转 ${comparison.improved}↑/${comparison.regressed}↓/${comparison.unchanged}=`,
	);
	for (const reason of comparison.reasons) {
		log.out(`  - ${reason}`);
	}
	log.out("");
	log.out(
		`下一步：pnpm exp decide ${command.slug} --verdict ${comparison.verdict === "better" ? "ship" : comparison.verdict === "worse" ? "no-ship" : "inconclusive"} --note "..."（判定是人做的，这条只是建议）`,
	);
	return { code: 0, registry: saved, record: next };
}

// 与 cli.ts 的展示保持一致：通过次数是尝试级的，10 题 ×3 次里过 15 次不能写成 15/10
function formatRun(run: ExperimentRun): string {
	const attempts = run.total * Math.max(run.repeat, 1);
	return `${pct(run.passRate)}（通过 ${run.passed}/${attempts} 次尝试）`;
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number): string {
	return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function short(value: string): string {
	return value.length > 12 ? value.slice(0, 12) : value;
}
