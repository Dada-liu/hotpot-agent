// 实验脚手架：把「一个功能需求」变成「一对可对比的 worktree + 一条台账记录」。
//
// 它只做三件事，其余留给已有工具：
//   1. 建隔离环境：head 分支 worktree + 锁在 baseCommit 的基线 worktree
//   2. 建台账：需求、假设、指标、套件、重复次数、回滚条件一次写清
//   3. 登记证据：把跑批结果按「条件一致」校验后写回，并算一个保守的方向结论
// 跑批本身仍由 `pnpm bench` 负责，对比的统计口径也在 bench 里——这里不重造。
//
// 一条纪律：所有命令都必须能在主工作区执行并写台账。worktree 里跑实验命令会让
// 记录跟着分支漂移，那正是「6 个 .worktrees 目录、没人记得在验证什么」的来源。

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelTier } from "@hotpot/core";
import { DEFAULT_REPEAT } from "../cli-args.ts";
import { DEFAULT_SUITE_NAME, loadBenchSuite } from "../suites.ts";
import {
	compareRuns,
	type RunArtifacts,
	readRunArtifacts,
	toExperimentRun,
	validateRun,
} from "./compare.ts";
import {
	addWorktree,
	branchExists,
	isAncestor,
	pruneWorktrees,
	removeWorktree,
	resolveCommit,
	resolveRepo,
	worktreeState,
} from "./git.ts";
import {
	assertValidSlug,
	experimentPaths,
	readRegistry,
	saveExperiment,
} from "./ledger.ts";
import {
	EXPERIMENT_SCHEMA_VERSION,
	type ExperimentRecord,
	type ExperimentRun,
	type ExperimentStatus,
	type ExperimentVariant,
	type ExperimentVerdict,
	findExperiment,
	findRun,
} from "./types.ts";

export const EXPERIMENT_USAGE = `Usage: pnpm exp <new|list|show|record|decide|close> [options]

Commands:
  new <slug>       建实验：head worktree（exp/<slug>）+ 基线 worktree + 台账
  list             列出全部实验（--status 过滤，--json 输出机器可读）
  show <slug>      查看一个实验：环境状态、跑批、对比、决策
  record <slug>    登记一轮跑批（--variant base|head）
  decide <slug>    写下人的决策（--verdict ship|no-ship|inconclusive）
  close <slug>     回收 worktree（分支保留）

new options:
  --hypothesis <text>    假设，必填：改哪一层、为什么有效
  --title <text>         需求标题（默认取 slug）
  --requirement <text>   需求原文；@<file> 从文件读
  --primary <text>       主指标（默认「尝试级通过率」）
  --guardrail <text>     护栏指标（默认「每通过题 token」）
  --rollback <text>      回滚条件（默认「主指标下降或护栏越界」）
  --base <ref>           基线分支/提交（默认 main）
  --suite <name>         评测套件（默认 ${DEFAULT_SUITE_NAME}）
  --repeat <k>           每题尝试次数（默认 ${DEFAULT_REPEAT}）
  --model-tier <tier>    模型档位 high|medium|low（默认取 settings）
  --instances-file <f>   实例文件（默认 <repo>/instances.jsonl，两个 worktree 共用）
  --no-base              不建基线 worktree
  --dry-run              只打印将要执行的动作

record options:
  --variant <v>          base | head（必填）
  --run <dir>            跑批目录（默认 <repo>/benchmark-runs/experiments/<slug>/<variant>）
  --force                覆盖已有决策（inconclusive 无需 --force）

decide options:
  --verdict <v>          ship | no-ship | inconclusive（必填）
  --note <text>          决策理由（必填）

close options:
  --force                工作区不干净时也回收
`;

export class ExperimentUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExperimentUsageError";
	}
}

interface NewCommand {
	kind: "new";
	slug: string;
	hypothesis: string;
	title?: string;
	requirement?: string;
	primaryMetric?: string;
	guardrailMetric?: string;
	rollback?: string;
	baseRef: string;
	suite: string;
	repeat: number;
	modelTier?: ModelTier;
	instancesFile?: string;
	withBase: boolean;
	dryRun: boolean;
}

interface ListCommand {
	kind: "list";
	status?: ExperimentStatus;
	json: boolean;
}

interface ShowCommand {
	kind: "show";
	slug: string;
}

interface RecordCommand {
	kind: "record";
	slug: string;
	variant: ExperimentVariant;
	runDir?: string;
	force: boolean;
}

interface DecideCommand {
	kind: "decide";
	slug: string;
	verdict: ExperimentVerdict;
	note: string;
}

interface CloseCommand {
	kind: "close";
	slug: string;
	force: boolean;
}

type ExperimentCommand =
	| { kind: "help" }
	| NewCommand
	| ListCommand
	| ShowCommand
	| RecordCommand
	| DecideCommand
	| CloseCommand;

export interface CliContext {
	cwd: string;
	out: (line: string) => void;
	err: (line: string) => void;
	now: () => Date;
}

export async function runExperimentCli(
	argv: string[],
	overrides: Partial<CliContext> = {},
): Promise<number> {
	const context: CliContext = {
		cwd: overrides.cwd ?? process.cwd(),
		out: overrides.out ?? ((line) => console.log(line)),
		err: overrides.err ?? ((line) => console.error(line)),
		now: overrides.now ?? (() => new Date()),
	};
	try {
		const command = parseExperimentArgs(argv);
		switch (command.kind) {
			case "help":
				context.out(EXPERIMENT_USAGE);
				return 0;
			case "new":
				return await runNew(command, context);
			case "list":
				return await runList(command, context);
			case "show":
				return await runShow(command, context);
			case "record":
				return await runRecord(command, context);
			case "decide":
				return await runDecide(command, context);
			case "close":
				return await runClose(command, context);
		}
	} catch (err) {
		context.err(
			`exp failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
}

function parseExperimentArgs(argv: string[]): ExperimentCommand {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		return { kind: "help" };
	}
	const command = argv[0];
	if (command === undefined) {
		return { kind: "help" };
	}
	const rest = argv.slice(1);
	switch (command) {
		case "new":
			return parseNew(rest);
		case "list":
			return parseList(rest);
		case "show":
			return { kind: "show", slug: takeSlug(rest).slug };
		case "record":
			return parseRecord(rest);
		case "decide":
			return parseDecide(rest);
		case "close":
			return parseClose(rest);
		default:
			throw new ExperimentUsageError(`unknown command: ${command}`);
	}
}

function parseNew(args: string[]): NewCommand {
	const { slug, flags } = takeSlug(args);
	const command: NewCommand = {
		kind: "new",
		slug,
		hypothesis: "",
		baseRef: "main",
		suite: DEFAULT_SUITE_NAME,
		repeat: DEFAULT_REPEAT,
		withBase: true,
		dryRun: false,
	};
	const cursor = new FlagCursor(flags);
	for (const { flag, inline } of cursor) {
		switch (flag) {
			case "--hypothesis":
				command.hypothesis = cursor.value(flag, inline);
				break;
			case "--title":
				command.title = cursor.value(flag, inline);
				break;
			case "--requirement":
				command.requirement = cursor.value(flag, inline);
				break;
			case "--primary":
				command.primaryMetric = cursor.value(flag, inline);
				break;
			case "--guardrail":
				command.guardrailMetric = cursor.value(flag, inline);
				break;
			case "--rollback":
				command.rollback = cursor.value(flag, inline);
				break;
			case "--base":
				command.baseRef = cursor.value(flag, inline);
				break;
			case "--suite":
				command.suite = cursor.value(flag, inline);
				break;
			case "--repeat":
				command.repeat = parsePositiveInt(flag, cursor.value(flag, inline));
				break;
			case "--model-tier":
				command.modelTier = parseModelTier(cursor.value(flag, inline));
				break;
			case "--instances-file":
				command.instancesFile = cursor.value(flag, inline);
				break;
			case "--no-base":
				assertBooleanFlag(flag, inline);
				command.withBase = false;
				break;
			case "--dry-run":
				assertBooleanFlag(flag, inline);
				command.dryRun = true;
				break;
			default:
				throw new ExperimentUsageError(`unknown option: ${flag}`);
		}
	}
	if (command.hypothesis.trim() === "") {
		throw new ExperimentUsageError(
			"new 需要 --hypothesis：没有可证伪的假设，跑完也判断不了这个功能是否有效",
		);
	}
	return command;
}

function parseList(args: string[]): ListCommand {
	const command: ListCommand = { kind: "list", json: false };
	const cursor = new FlagCursor(args);
	for (const { flag, inline } of cursor) {
		switch (flag) {
			case "--status": {
				const value = cursor.value(flag, inline);
				if (value !== "open" && value !== "decided" && value !== "closed") {
					throw new ExperimentUsageError(
						"--status must be open, decided or closed",
					);
				}
				command.status = value;
				break;
			}
			case "--json":
				assertBooleanFlag(flag, inline);
				command.json = true;
				break;
			default:
				throw new ExperimentUsageError(`unknown option: ${flag}`);
		}
	}
	return command;
}

function parseRecord(args: string[]): RecordCommand {
	const { slug, flags } = takeSlug(args);
	let variant: ExperimentVariant | undefined;
	let runDir: string | undefined;
	let force = false;
	const cursor = new FlagCursor(flags);
	for (const { flag, inline } of cursor) {
		switch (flag) {
			case "--variant": {
				const value = cursor.value(flag, inline);
				if (value !== "base" && value !== "head") {
					throw new ExperimentUsageError("--variant must be base or head");
				}
				variant = value;
				break;
			}
			case "--run":
				runDir = cursor.value(flag, inline);
				break;
			case "--force":
				assertBooleanFlag(flag, inline);
				force = true;
				break;
			default:
				throw new ExperimentUsageError(`unknown option: ${flag}`);
		}
	}
	if (variant === undefined) {
		throw new ExperimentUsageError("record 需要 --variant base|head");
	}
	return { kind: "record", slug, variant, runDir, force };
}

function parseDecide(args: string[]): DecideCommand {
	const { slug, flags } = takeSlug(args);
	let verdict: ExperimentVerdict | undefined;
	let note = "";
	const cursor = new FlagCursor(flags);
	for (const { flag, inline } of cursor) {
		switch (flag) {
			case "--verdict": {
				const value = cursor.value(flag, inline);
				if (
					value !== "ship" &&
					value !== "no-ship" &&
					value !== "inconclusive"
				) {
					throw new ExperimentUsageError(
						"--verdict must be ship, no-ship or inconclusive",
					);
				}
				verdict = value;
				break;
			}
			case "--note":
				note = cursor.value(flag, inline);
				break;
			default:
				throw new ExperimentUsageError(`unknown option: ${flag}`);
		}
	}
	if (verdict === undefined) {
		throw new ExperimentUsageError(
			"decide 需要 --verdict ship|no-ship|inconclusive",
		);
	}
	if (note.trim() === "") {
		throw new ExperimentUsageError("decide 需要 --note：决策必须留下理由");
	}
	return { kind: "decide", slug, verdict, note };
}

function parseClose(args: string[]): CloseCommand {
	const { slug, flags } = takeSlug(args);
	let force = false;
	const cursor = new FlagCursor(flags);
	for (const { flag, inline } of cursor) {
		switch (flag) {
			case "--force":
				assertBooleanFlag(flag, inline);
				force = true;
				break;
			default:
				throw new ExperimentUsageError(`unknown option: ${flag}`);
		}
	}
	return { kind: "close", slug, force };
}

async function runNew(command: NewCommand, ctx: CliContext): Promise<number> {
	const slug = assertValidSlug(command.slug);
	const repo = await resolveRepo(ctx.cwd);
	if (!repo.isMain) {
		throw new Error(
			`new 必须在主工作区执行（${repo.mainRoot}）：在 worktree 里再开实验，台账会跟着分支漂移`,
		);
	}
	const paths = experimentPaths(repo.mainRoot, slug);
	const suite = await loadBenchSuite(command.suite);
	const registry = await readRegistry(repo.mainRoot);
	if (findExperiment(registry, slug) !== undefined) {
		throw new Error(
			`实验 ${slug} 已在台账里：pnpm exp show ${slug}（要重做请换 slug 或先 close）`,
		);
	}
	if (await branchExists(repo.mainRoot, paths.branch)) {
		throw new Error(
			`分支 ${paths.branch} 已存在：换一个 slug，或先 git branch -D ${paths.branch}`,
		);
	}
	const headPath = join(repo.mainRoot, paths.worktree);
	const basePath = join(repo.mainRoot, paths.baseWorktree);
	for (const path of command.withBase ? [headPath, basePath] : [headPath]) {
		if (existsSync(path)) {
			throw new Error(
				`目录已存在：${path}（先在主工作区执行 git worktree prune，或手动确认它是什么）`,
			);
		}
	}
	const baseCommit = await resolveCommit(repo.mainRoot, command.baseRef);
	const instancesFile = resolve(
		repo.mainRoot,
		command.instancesFile ?? "instances.jsonl",
	);
	const now = ctx.now().toISOString();

	const record: ExperimentRecord = {
		slug,
		title: command.title ?? slug,
		status: "open",
		createdAt: now,
		updatedAt: now,
		branch: paths.branch,
		worktree: paths.worktree,
		...(command.withBase ? { baseWorktree: paths.baseWorktree } : {}),
		baseRef: command.baseRef,
		baseCommit,
		suite: suite.name,
		repeat: command.repeat,
		...(command.modelTier === undefined
			? {}
			: { modelTier: command.modelTier }),
		instancesFile,
		...(command.requirement === undefined
			? {}
			: { requirement: await readRequirement(command.requirement, ctx.cwd) }),
		hypothesis: command.hypothesis.trim(),
		primaryMetric: command.primaryMetric ?? `尝试级通过率（${suite.name}）`,
		guardrailMetric: command.guardrailMetric ?? "每通过题 token",
		rollback: command.rollback ?? "主指标下降或护栏越界",
		runs: [],
	};

	if (command.dryRun) {
		ctx.out(
			`[dry-run] 将创建 ${paths.branch} -> ${paths.worktree} @ ${baseCommit}`,
		);
		if (command.withBase) {
			ctx.out(
				`[dry-run] 将创建 detached 基线 ${paths.baseWorktree} @ ${baseCommit}`,
			);
		}
		ctx.out(`[dry-run] 将写入 docs/experiments/registry.json 与 ${slug}.md`);
		ctx.out("");
		printNextSteps(record, repo.mainRoot, ctx, { dryRun: true });
		return 0;
	}

	const created: string[] = [];
	try {
		await addWorktree({
			cwd: repo.mainRoot,
			path: headPath,
			commit: baseCommit,
			branch: paths.branch,
			detached: false,
		});
		created.push(headPath);
		if (command.withBase) {
			await addWorktree({
				cwd: repo.mainRoot,
				path: basePath,
				commit: baseCommit,
				detached: true,
			});
			created.push(basePath);
		}
		await saveExperiment(repo.mainRoot, registry, record);
	} catch (err) {
		// 台账写失败时把 worktree 一起撤掉：留下没有记录的目录，正是
		// .worktrees 里堆了 6 个孤儿的原因
		for (const path of created) {
			await removeWorktree(repo.mainRoot, path, true).catch(() => undefined);
		}
		await pruneWorktrees(repo.mainRoot);
		throw err;
	}

	ctx.out(`实验 ${slug} 已建好`);
	ctx.out(`  head   ${paths.worktree}  分支 ${paths.branch}`);
	if (command.withBase) {
		ctx.out(`  base   ${paths.baseWorktree}  detached @ ${short(baseCommit)}`);
	}
	ctx.out(`  台账   docs/experiments/${slug}.md`);
	if (!existsSync(instancesFile)) {
		ctx.err(
			`warning: 实例文件不存在：${instancesFile}\n  先导出一份（两个 worktree 共用，题集才不会一边一个）：\n  source ~/swebench-venv/bin/activate && python benchmarks/scripts/export_instances.py --dataset ${suite.dataset} --split ${suite.split} --output ${instancesFile}`,
		);
	}
	ctx.out("");
	printNextSteps(record, repo.mainRoot, ctx, { dryRun: false });
	return 0;
}

function printNextSteps(
	record: ExperimentRecord,
	mainRoot: string,
	ctx: CliContext,
	opts: { dryRun: boolean },
): void {
	const paths = experimentPaths(mainRoot, record.slug);
	const headAbs = join(mainRoot, paths.worktree);
	const baseAbs = join(mainRoot, paths.baseWorktree);
	const bench = (output: string): string => {
		const args = [
			"pnpm bench swebench",
			`--instances-file ${record.instancesFile}`,
			`--repeat ${record.repeat}`,
			...(record.modelTier === undefined
				? []
				: [`--model-tier ${record.modelTier}`]),
			`--output ${output}`,
		];
		return args.join(" ");
	};

	ctx.out(
		"下一步（两个 worktree 各跑一轮，条件完全相同：同一份实例文件、同一重复次数）：",
	);
	if (record.baseWorktree !== undefined) {
		ctx.out(
			`  cd ${baseAbs} && pnpm install && ${bench(join(paths.runsRoot, "base"))}`,
		);
	} else {
		ctx.out(
			`  # 未建基线 worktree（--no-base）：需自己在 ${short(record.baseCommit)} 上跑，并保证 manifest.commit 与它一致`,
		);
	}
	ctx.out(
		`  cd ${headAbs} && pnpm install && ${bench(join(paths.runsRoot, "head"))}`,
	);
	ctx.out("");
	ctx.out("跑完登记（会校验提交、题集、重复次数，任何一项不同都拒绝登记）：");
	ctx.out(`  pnpm exp record ${record.slug} --variant base`);
	ctx.out(`  pnpm exp record ${record.slug} --variant head`);
	ctx.out(`  pnpm exp show ${record.slug}`);
	if (opts.dryRun) {
		ctx.out("");
		ctx.out("[dry-run] 以上命令只是预览，没有创建任何东西");
	}
}

async function runList(command: ListCommand, ctx: CliContext): Promise<number> {
	const repo = await resolveRepo(ctx.cwd);
	const registry = await readRegistry(repo.mainRoot);
	const records =
		command.status === undefined
			? registry.experiments
			: registry.experiments.filter((item) => item.status === command.status);
	if (command.json) {
		ctx.out(
			JSON.stringify(
				{ schemaVersion: EXPERIMENT_SCHEMA_VERSION, experiments: records },
				null,
				2,
			),
		);
		return 0;
	}
	if (records.length === 0) {
		ctx.out(
			`台账为空（docs/experiments/registry.json）：先 pnpm exp new <slug> --hypothesis "..."`,
		);
		return 0;
	}
	const rows = records.map((record) => [
		record.slug,
		statusLabel(record.status),
		short(record.baseCommit),
		runSummary(record),
		record.comparison?.verdict ?? "-",
		record.decision?.verdict ?? "-",
		record.updatedAt.slice(0, 10),
	]);
	const header = ["SLUG", "状态", "基线", "跑批", "对比", "决策", "更新"];
	const widths = header.map((title, index) =>
		Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
	);
	const format = (row: string[]): string =>
		row
			.map((cell, index) => pad(cell, widths[index] ?? cell.length))
			.join("  ");
	ctx.out(format(header));
	for (const row of rows) {
		ctx.out(format(row));
	}
	return 0;
}

async function runShow(command: ShowCommand, ctx: CliContext): Promise<number> {
	const repo = await resolveRepo(ctx.cwd);
	const registry = await readRegistry(repo.mainRoot);
	const record = findExperiment(registry, command.slug);
	if (record === undefined) {
		throw new Error(`台账里没有 ${command.slug}：pnpm exp list`);
	}
	const headPath = join(repo.mainRoot, record.worktree);
	ctx.out(`${record.title}  [${statusLabel(record.status)}]`);
	ctx.out(
		`  基线     ${record.baseRef} @ ${short(record.baseCommit)}（head 必须包含它：${await ancestorState(repo.mainRoot, record, headPath)}）`,
	);
	ctx.out(`  分支     ${record.branch}`);
	ctx.out(`  head     ${describeWorktree(headPath)}`);
	if (record.baseWorktree !== undefined) {
		ctx.out(
			`  base     ${describeWorktree(join(repo.mainRoot, record.baseWorktree))}`,
		);
	}
	ctx.out(`  套件     ${record.suite} × ${record.repeat}`);
	ctx.out(`  实例     ${record.instancesFile}`);
	if (record.requirement !== undefined) {
		ctx.out(`  需求     ${record.requirement.split("\n")[0] ?? ""}`);
	}
	ctx.out(`  假设     ${record.hypothesis}`);
	ctx.out(
		`  指标     主：${record.primaryMetric}；护栏：${record.guardrailMetric}；回滚：${record.rollback}`,
	);
	ctx.out("");
	if (record.runs.length === 0) {
		ctx.out("跑批：尚未登记");
	} else {
		ctx.out("跑批：");
		for (const run of record.runs) {
			ctx.out(
				`  ${run.variant.padEnd(4)} ${short(run.runId)}  ${formatRun(run)}  每轮 ${run.passRateByAttempt.map((value) => pct(value)).join("/")}  token/通过题 ${run.tokensPerResolved === null ? "n/a" : Math.round(run.tokensPerResolved)}  @${short(run.commit ?? "unknown")}`,
			);
			ctx.out(`        ${run.dir}`);
		}
	}
	ctx.out("");
	if (record.comparison === undefined) {
		ctx.out("对比：尚未生成（base 与 head 都登记后自动算）");
	} else {
		const comparison = record.comparison;
		ctx.out(
			`对比：${comparison.verdict}  差异 ${signed(comparison.deltaPp)}pp  阈值 ${comparison.noisePp.toFixed(1)}pp  翻转 ${comparison.improved}↑/${comparison.regressed}↓/${comparison.unchanged}=`,
		);
		for (const reason of comparison.reasons) {
			ctx.out(`  - ${reason}`);
		}
		if (comparison.perInstance.length > 0) {
			const changed = comparison.perInstance.filter(
				(item) => item.headPassed !== item.basePassed,
			);
			if (changed.length > 0) {
				ctx.out("  逐题变化：");
				for (const item of changed) {
					ctx.out(
						`    ${item.instanceId}  ${item.basePassed}/${item.attempts} -> ${item.headPassed}/${item.attempts}`,
					);
				}
			}
		}
	}
	ctx.out("");
	if (record.decision === undefined) {
		ctx.out("决策：尚未写下");
		ctx.out(
			`  下一步：pnpm exp decide ${record.slug} --verdict ship|no-ship|inconclusive --note "..."`,
		);
	} else {
		ctx.out(`决策：${record.decision.verdict}`);
		ctx.out(`  理由：${record.decision.note}`);
		ctx.out(`  时间：${record.decision.at}`);
	}
	return 0;
}

async function runRecord(
	command: RecordCommand,
	ctx: CliContext,
): Promise<number> {
	const repo = await resolveRepo(ctx.cwd);
	const registry = await readRegistry(repo.mainRoot);
	const record = findExperiment(registry, command.slug);
	if (record === undefined) {
		throw new Error(`台账里没有 ${command.slug}：pnpm exp list`);
	}
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
			: resolve(ctx.cwd, command.runDir);
	const artifacts = await readRunArtifacts(runDir);

	const headPath = join(repo.mainRoot, record.worktree);
	const headState = existsSync(headPath)
		? await worktreeState(headPath)
		: undefined;
	const otherEntry = record.runs.find(
		(item) => item.variant !== command.variant,
	);
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
		ctx.err(`拒绝登记 ${command.slug} 的 ${command.variant} 跑批：`);
		for (const error of validation.errors) {
			ctx.err(`  - ${error}`);
		}
		return 1;
	}
	for (const warning of [...validation.warnings, ...warnings]) {
		ctx.err(`warning: ${warning}`);
	}

	const now = ctx.now().toISOString();
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
		...(comparison === undefined ? {} : { comparison }),
	};
	if (command.force && next.decision !== undefined) {
		delete next.decision;
	}
	if (next.status === "closed") {
		next.status = "open";
	}
	await saveExperiment(repo.mainRoot, registry, next);

	ctx.out(
		`已登记 ${command.slug} 的 ${command.variant}：${short(run.runId)}  ${formatRun(run)}  每轮 ${run.passRateByAttempt.map((value) => pct(value)).join(" / ")}`,
	);
	ctx.out(`  目录 ${run.dir}`);
	if (next.decision === undefined && record.decision !== undefined) {
		ctx.out("  已丢弃原决策：证据变了，结论要重新判");
	}
	if (comparison === undefined) {
		const other = command.variant === "base" ? "head" : "base";
		ctx.out(
			`  另一变体尚未登记：pnpm exp record ${command.slug} --variant ${other}`,
		);
		return 0;
	}
	ctx.out("");
	ctx.out(
		`对比：${comparison.verdict}  差异 ${signed(comparison.deltaPp)}pp  阈值 ${comparison.noisePp.toFixed(1)}pp  翻转 ${comparison.improved}↑/${comparison.regressed}↓/${comparison.unchanged}=`,
	);
	for (const reason of comparison.reasons) {
		ctx.out(`  - ${reason}`);
	}
	ctx.out("");
	ctx.out(
		`下一步：pnpm exp decide ${command.slug} --verdict ${comparison.verdict === "better" ? "ship" : comparison.verdict === "worse" ? "no-ship" : "inconclusive"} --note "..."（判定是人做的，这条只是建议）`,
	);
	return 0;
}

async function runDecide(
	command: DecideCommand,
	ctx: CliContext,
): Promise<number> {
	const repo = await resolveRepo(ctx.cwd);
	const registry = await readRegistry(repo.mainRoot);
	const record = findExperiment(registry, command.slug);
	if (record === undefined) {
		throw new Error(`台账里没有 ${command.slug}：pnpm exp list`);
	}
	const now = ctx.now().toISOString();
	const comparison = record.comparison;
	if (comparison === undefined && command.verdict !== "inconclusive") {
		ctx.err(
			"warning: 没有任何对比数据，这条决策只凭代码评审——台账会如实记下这一点",
		);
	}
	if (
		comparison !== undefined &&
		comparison.verdict === "worse" &&
		command.verdict === "ship"
	) {
		ctx.err("warning: 对比结论是 worse，仍选择 ship：请确认理由能解释这个矛盾");
	}
	if (
		comparison !== undefined &&
		comparison.verdict === "inconclusive" &&
		command.verdict !== "inconclusive"
	) {
		ctx.err(
			"warning: 数据不足以判定（inconclusive），这是人的决定，不是数据支持的决定",
		);
	}
	const next: ExperimentRecord = {
		...record,
		status: "decided",
		updatedAt: now,
		decision: {
			verdict: command.verdict,
			note: command.note.trim(),
			at: now,
			...(comparison === undefined ? {} : { comparison }),
		},
	};
	await saveExperiment(repo.mainRoot, registry, next);
	ctx.out(`已记录决策：${command.slug} -> ${command.verdict}`);
	ctx.out(`  理由：${next.decision?.note ?? ""}`);
	if (command.verdict === "ship") {
		ctx.out(
			`  上线前请把 ${record.branch} 合入 ${record.baseRef}；回滚条件：${record.rollback}`,
		);
	} else {
		ctx.out(`  回滚条件写在这里是为了上线后仍能判断：${record.rollback}`);
	}
	ctx.out(`  回收环境：pnpm exp close ${command.slug}`);
	return 0;
}

async function runClose(
	command: CloseCommand,
	ctx: CliContext,
): Promise<number> {
	const repo = await resolveRepo(ctx.cwd);
	const registry = await readRegistry(repo.mainRoot);
	const record = findExperiment(registry, command.slug);
	if (record === undefined) {
		throw new Error(`台账里没有 ${command.slug}：pnpm exp list`);
	}
	if (record.status === "closed") {
		ctx.out(`${command.slug} 已回收：结论与跑批记录保留在台账里`);
		return 0;
	}
	const targets = [record.worktree, record.baseWorktree].filter(
		(path): path is string => path !== undefined,
	);
	for (const relative of targets) {
		const path = join(repo.mainRoot, relative);
		if (!existsSync(path)) {
			continue;
		}
		const state = await worktreeState(path);
		if (state.dirty && !command.force) {
			// 不静默丢弃未提交的改动：那可能是还没登记成跑批的实验代码
			ctx.err(
				`${relative} 有未提交的改动，拒绝回收（确认无用后加 --force，或先提交到 ${record.branch}）`,
			);
			return 1;
		}
		await removeWorktree(repo.mainRoot, path, command.force);
		ctx.out(`已回收 ${relative}`);
	}
	await pruneWorktrees(repo.mainRoot);
	const now = ctx.now().toISOString();
	const next: ExperimentRecord = {
		...record,
		status: "closed",
		updatedAt: now,
		closedAt: now,
	};
	await saveExperiment(repo.mainRoot, registry, next);
	ctx.out(`分支 ${record.branch} 保留（未合入的代码不会因为回收而丢）`);
	ctx.out(`台账：docs/experiments/${record.slug}.md`);
	return 0;
}

async function readRequirement(value: string, cwd: string): Promise<string> {
	if (!value.startsWith("@")) {
		return value;
	}
	const path = resolve(cwd, value.slice(1));
	return (await readFile(path, "utf8")).trim();
}

async function ancestorState(
	mainRoot: string,
	record: ExperimentRecord,
	headPath: string,
): Promise<string> {
	if (!existsSync(headPath)) {
		return "worktree 已回收";
	}
	const state = await worktreeState(headPath);
	if (state.commit === null) {
		return "取不到 HEAD";
	}
	const ancestor = await isAncestor(mainRoot, record.baseCommit, state.commit);
	return ancestor
		? "是"
		: "否：分支被 rebase 或基线不在其历史里，差异不再只是这一个改动";
}

function describeWorktree(path: string): string {
	if (!existsSync(path)) {
		return `缺失（${path}）`;
	}
	return path;
}

function runSummary(record: ExperimentRecord): string {
	const base = findRun(record, "base");
	const head = findRun(record, "head");
	if (base === undefined && head === undefined) {
		return "-";
	}
	return `${base === undefined ? "·" : "B"}${head === undefined ? "·" : "H"}`;
}

function statusLabel(status: ExperimentStatus): string {
	switch (status) {
		case "open":
			return "进行中";
		case "decided":
			return "已决策";
		case "closed":
			return "已回收";
	}
}

// 通过次数是「尝试级」的：10 题 ×3 次里通过 15 次，不能写成 15/10
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

function pad(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - value.length));
}

// 取位置参数：子命令后面必须紧跟 slug，且不能是 --flag
function takeSlug(args: string[]): { slug: string; flags: string[] } {
	const first = args[0];
	if (first === undefined || first.startsWith("--")) {
		throw new ExperimentUsageError("缺少 <slug>");
	}
	return { slug: first, flags: args.slice(1) };
}

class FlagCursor {
	private readonly args: string[];
	private index = 0;

	constructor(args: string[]) {
		this.args = args;
	}

	*[Symbol.iterator](): Generator<{ flag: string; inline?: string }> {
		while (this.index < this.args.length) {
			const raw = this.args[this.index];
			this.index += 1;
			if (raw === undefined) {
				return;
			}
			if (!raw.startsWith("--")) {
				throw new ExperimentUsageError(`unexpected argument: ${raw}`);
			}
			const separator = raw.indexOf("=");
			if (separator === -1) {
				yield { flag: raw };
			} else {
				yield {
					flag: raw.slice(0, separator),
					inline: raw.slice(separator + 1),
				};
			}
		}
	}

	value(flag: string, inline?: string): string {
		if (inline !== undefined) {
			if (inline === "") {
				throw new ExperimentUsageError(`${flag} requires a value`);
			}
			return inline;
		}
		const value = this.args[this.index];
		if (value === undefined || value.startsWith("--")) {
			throw new ExperimentUsageError(`${flag} requires a value`);
		}
		this.index += 1;
		return value;
	}
}

function assertBooleanFlag(flag: string, inline?: string): void {
	if (inline !== undefined) {
		throw new ExperimentUsageError(`${flag} does not take a value`);
	}
}

function parsePositiveInt(flag: string, value: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new ExperimentUsageError(`${flag} must be a positive integer`);
	}
	return Number(value);
}

function parseModelTier(value: string): ModelTier {
	if (value === "high" || value === "medium" || value === "low") {
		return value;
	}
	throw new ExperimentUsageError("--model-tier must be high, medium or low");
}
