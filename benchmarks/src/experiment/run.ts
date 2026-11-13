// 双版本跑批编排：`pnpm exp run <slug>` 把「两个 worktree 各跑一次 bench，再登记两次」
// 压成一条命令。它不重新实现跑批，只在正确的目录里调用 `pnpm bench swebench`。
//
// 三条纪律：
// 1. 开跑前把「会白跑」的条件全部拦掉（worktree 脏、基线漂移、实例文件缺失、
//    已有产物和当前代码对不上），因为一轮 10 题 ×3 的钱和时间花出去就收不回来。
// 2. 子进程日志必须同时进控制台和文件：跑批动辄数小时，中断后只剩终端回滚区
//    等于没有排查线索。
// 3. 任一变体失败立即停止，且**不做任何登记**。半套证据写进台账比没写更糟——
//    它看起来像一次完整的实验。

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_FILE } from "../manifest.ts";
import {
	type CommandResult,
	type RunCommandOptions,
	runCommand,
} from "../process.ts";
import { readRunArtifacts } from "./compare.ts";
import { isAncestor, worktreeState } from "./git.ts";
import { experimentPaths, readRegistry } from "./ledger.ts";
import { type RecordLogger, registerRun } from "./record.ts";
import {
	type ExperimentRecord,
	type ExperimentVariant,
	findExperiment,
} from "./types.ts";

export type CommandExecutor = (
	command: string,
	args: string[],
	opts: RunCommandOptions,
) => Promise<CommandResult>;

export const defaultExecutor: CommandExecutor = runCommand;

export interface RunExperimentInput {
	mainRoot: string;
	cwd: string;
	record: ExperimentRecord;
	variants: ExperimentVariant[];
	skipInstall: boolean;
	force: boolean;
	dryRun: boolean;
	noRecord: boolean;
	evalMode?: string;
	evalHost?: string;
	maxWorkers?: number;
	now: () => Date;
	log: RecordLogger;
	exec: CommandExecutor;
}

export interface RunExperimentResult {
	code: number;
	executed: ExperimentVariant[];
	skipped: ExperimentVariant[];
	registered: boolean;
}

interface VariantPlan {
	variant: ExperimentVariant;
	worktree: string;
	runDir: string;
	commit: string;
	reuse: boolean;
	resume: boolean;
}

export async function runExperiment(
	input: RunExperimentInput,
): Promise<RunExperimentResult> {
	const { log } = input;
	const empty: RunExperimentResult = {
		code: 1,
		executed: [],
		skipped: [],
		registered: false,
	};
	const record = input.record;
	const paths = experimentPaths(input.mainRoot, record.slug);

	// ---- 前置校验：失败要早，且要给出可执行的修复动作 ----
	if (record.status === "closed") {
		log.err(
			`实验 ${record.slug} 已回收（worktree 被删）：要重跑请新开一个 slug，台账里的结论保留`,
		);
		return empty;
	}
	if (
		record.decision !== undefined &&
		record.decision.verdict !== "inconclusive"
	) {
		log.err(
			`实验 ${record.slug} 已决策（${record.decision.verdict}）：重跑会改写结论的依据，请新开一个实验`,
		);
		return empty;
	}
	if (input.variants.length === 0) {
		log.err("run 至少要指定一个变体（--variants base,head）");
		return empty;
	}
	if (!existsSync(record.instancesFile)) {
		log.err(
			`实例文件不存在：${record.instancesFile}\n  两个 worktree 必须共用同一份，否则题目集合会不一样。先导出：\n  source ~/swebench-venv/bin/activate && python benchmarks/scripts/export_instances.py --dataset SWE-bench/SWE-bench_Lite --split test --output ${record.instancesFile}`,
		);
		return empty;
	}

	const plans: VariantPlan[] = [];
	for (const variant of input.variants) {
		const relative = variant === "head" ? record.worktree : record.baseWorktree;
		if (relative === undefined) {
			log.err(
				`台账里没有基线 worktree（建实验时用了 --no-base）：无法自动跑 base。\n  请在 ${record.baseCommit} 上手动跑一轮，再用 pnpm exp record ${record.slug} --variant base --run <dir> 登记`,
			);
			return empty;
		}
		const worktree = join(input.mainRoot, relative);
		if (!existsSync(worktree)) {
			log.err(
				`worktree 不存在：${worktree}（先 git worktree prune，或新开实验）`,
			);
			return empty;
		}
		const state = await worktreeState(worktree);
		if (state.dirty) {
			log.err(
				`${relative} 有未提交的改动：跑批时 manifest.git.dirty 会是 true，登记会被拒绝。先提交或清理`,
			);
			return empty;
		}
		if (state.commit === null) {
			log.err(`${relative}: 取不到 HEAD`);
			return empty;
		}
		if (variant === "base" && state.commit !== record.baseCommit) {
			log.err(
				`基线 worktree 的 HEAD 是 ${state.commit}，台账锁定的是 ${record.baseCommit}：基线漂移了，重开实验`,
			);
			return empty;
		}
		if (
			variant === "head" &&
			!(await isAncestor(input.mainRoot, record.baseCommit, state.commit))
		) {
			log.err(
				`warning: ${record.baseCommit} 不在 head 的历史里（分支被 rebase 或基线换过）：这轮差异不再只是这个功能`,
			);
		}

		const runDir = join(paths.runsRoot, variant);
		let reuse = false;
		let resume = false;
		if (!input.force && existsSync(join(runDir, MANIFEST_FILE))) {
			try {
				const previous = await readRunArtifacts(runDir);
				if (previous.manifest.status === "completed") {
					if (previous.manifest.agent.git.commit !== state.commit) {
						log.err(
							`${runDir} 已有一轮完成的跑批，但提交与当前 worktree 不一致（${previous.manifest.agent.git.commit ?? "unknown"} vs ${state.commit}）：加 --force 重跑，旧产物会保留为 .bak`,
						);
						return empty;
					}
					if ((previous.manifest.repeat ?? 1) !== record.repeat) {
						log.err(
							`${runDir} 已有跑批的 --repeat 是 ${previous.manifest.repeat ?? 1}，台账记录的是 ${record.repeat}：加 --force 重跑`,
						);
						return empty;
					}
					reuse = true;
				} else {
					resume = true;
				}
			} catch {
				// manifest 在、report 读不出来 = 上次没走完收尾，带 --resume 接着跑
				resume = true;
			}
		}
		plans.push({
			variant,
			worktree,
			runDir,
			commit: state.commit,
			reuse,
			resume,
		});
	}

	// ---- 打印计划 ----
	log.out(`实验 ${record.slug}：${record.suite} × ${record.repeat} 次尝试`);
	log.out(`  实例 ${record.instancesFile}`);
	for (const plan of plans) {
		const status = plan.reuse
			? "已有完成跑批，跳过"
			: plan.resume
				? "上次未完成，带 --resume 续跑"
				: input.force
					? "强制重跑（旧产物移为 .bak）"
					: "新跑";
		log.out(`  ${plan.variant.padEnd(4)} ${plan.worktree}  ${status}`);
	}
	log.out("");

	if (input.dryRun) {
		for (const plan of plans) {
			if (plan.reuse) {
				continue;
			}
			log.out(`[dry-run] ${plan.variant}：`);
			if (!input.skipInstall) {
				log.out(`  cd ${plan.worktree} && pnpm install`);
			}
			log.out(
				`  cd ${plan.worktree} && ${benchCommand(record, plan, input).join(" ")}`,
			);
		}
		log.out("[dry-run] 不会执行任何命令，也不会登记");
		return { code: 0, executed: [], skipped: [], registered: false };
	}

	// ---- 顺序执行：base 先、head 后；失败即停 ----
	const executed: ExperimentVariant[] = [];
	const skipped: ExperimentVariant[] = [];
	for (const plan of plans) {
		if (plan.reuse) {
			skipped.push(plan.variant);
			log.out(`[${plan.variant}] 复用 ${plan.runDir} 的已完成跑批`);
			continue;
		}
		if (input.force && existsSync(plan.runDir)) {
			const backup = `${plan.runDir}.bak-${input.now().toISOString().replace(/[:.]/g, "-")}`;
			await rename(plan.runDir, backup);
			log.out(`[${plan.variant}] 旧产物移到 ${backup}`);
		}
		mkdirSync(plan.runDir, { recursive: true });
		const logPath = join(plan.runDir, "exp-run.log");
		appendFileSync(
			logPath,
			`\n=== ${input.now().toISOString()} | ${plan.variant} | ${plan.commit} | ${record.suite} × ${record.repeat} ===\n`,
		);

		if (!input.skipInstall) {
			const code = await execStep(input, "pnpm", ["install"], plan, logPath);
			if (code !== 0) {
				return { ...empty, executed, skipped };
			}
		}
		const code = await execStep(
			input,
			"pnpm",
			benchCommand(record, plan, input).slice(1),
			plan,
			logPath,
		);
		if (code !== 0) {
			return { ...empty, executed, skipped };
		}
		executed.push(plan.variant);
		log.out(`[${plan.variant}] 跑批完成 -> ${plan.runDir}`);
	}

	if (input.noRecord) {
		log.out("已跳过自动登记（--no-record）：产物留在上面的目录里");
		return { code: 0, executed, skipped, registered: false };
	}

	// ---- 自动登记：包括本轮跳过的变体，保证两轮齐了就能算出对比 ----
	let registry = await readRegistry(input.mainRoot);
	let current = findExperiment(registry, record.slug);
	if (current === undefined) {
		log.err(
			`台账里找不到 ${record.slug}：登记已跳过，产物仍在 ${paths.runsRoot}`,
		);
		return { code: 1, executed, skipped, registered: false };
	}
	for (const [index, variant] of input.variants.entries()) {
		const result = await registerRun({
			mainRoot: input.mainRoot,
			cwd: input.cwd,
			registry,
			record: current,
			variant,
			force: false,
			now: input.now,
			log,
			// 重跑场景：台账里可能留着旧「另一变体」。第一次登记时忽略它，
			// 第二次登记会读刚写盘的产物，拿到的才是本次这一对
			...(index === 0 && input.variants.length > 1
				? { ignoreOther: true }
				: {}),
		});
		if (result.code !== 0) {
			log.err("自动登记失败：跑批产物保留，修好后可单独执行 pnpm exp record");
			return { code: 1, executed, skipped, registered: false };
		}
		registry = result.registry;
		current = result.record;
	}
	log.out("");
	log.out(`登记完成：pnpm exp show ${record.slug}`);
	return { code: 0, executed, skipped, registered: true };
}

function benchCommand(
	record: ExperimentRecord,
	plan: VariantPlan,
	input: RunExperimentInput,
): string[] {
	return [
		"pnpm",
		"bench",
		"swebench",
		"--suite",
		record.suite,
		"--instances-file",
		record.instancesFile,
		"--repeat",
		String(record.repeat),
		...(record.modelTier === undefined
			? []
			: ["--model-tier", record.modelTier]),
		"--output",
		plan.runDir,
		...(input.evalMode === undefined ? [] : ["--eval-mode", input.evalMode]),
		...(input.evalHost === undefined ? [] : ["--eval-host", input.evalHost]),
		...(input.maxWorkers === undefined
			? []
			: ["--max-workers", String(input.maxWorkers)]),
		...(plan.resume ? ["--resume"] : []),
	];
}

async function execStep(
	input: RunExperimentInput,
	command: string,
	args: string[],
	plan: VariantPlan,
	logPath: string,
): Promise<number> {
	const { log } = input;
	const line = [command, ...args].join(" ");
	log.out(`[${plan.variant}] $ ${line}`);
	appendFileSync(logPath, `\n$ ${line}\n`);
	const emit = (chunk: string, level: "out" | "err"): void => {
		appendFileSync(logPath, chunk);
		const text = chunk.trimEnd();
		if (text === "") {
			return;
		}
		for (const part of text.split("\n")) {
			log[level](`  ${part}`);
		}
	};
	const result = await input.exec(command, args, {
		cwd: plan.worktree,
		onStdout: (chunk) => emit(chunk, "out"),
		onStderr: (chunk) => emit(chunk, "err"),
	});
	if (result.timedOut) {
		log.err(`[${plan.variant}] 命令超时，已终止：${line}`);
	}
	if (result.code !== 0) {
		log.err(
			`[${plan.variant}] 命令失败（exit ${result.code}）：${line}\n  日志 ${logPath}\n${result.stderr
				.trim()
				.split("\n")
				.slice(-12)
				.map((item) => `  ${item}`)
				.join("\n")}`,
		);
		log.err(
			`已完成的变体不会自动登记。修好后重跑 pnpm exp run ${input.record.slug}（会复用已完成的、续跑未完成的）`,
		);
	}
	return result.code;
}
