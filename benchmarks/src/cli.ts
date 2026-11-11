// `pnpm bench` 入口：swebench 走「实例 → worktree → 无交互 agent → patch → 官方评测 → 报告」，
// custom 走「三类种子任务 → 无交互 agent → 本地校验 → 报告」。
// CLI 只做编排与日志；评分全部交给官方 swebench harness。
// 失败语义：参数错误/评测失败返回非 0；通过率不足 100% 仍是正常结束（benchmark 本来就允许失败题）。

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type ModelTier } from "@hotpot/core";
import { runAgentTurn } from "./agent-runner.ts";
import {
	BENCH_USAGE,
	type CustomCommand,
	parseBenchArgs,
	type SwebenchCommand,
	UsageError,
} from "./cli-args.ts";
import { runCustomTask } from "./custom/runner.ts";
import { loadCustomTasks } from "./custom/task.ts";
import {
	type BenchmarkSuite,
	collectAgentFacts,
	collectModelFingerprints,
	createRunManifest,
	finalizeRunManifest,
	hashStrings,
	hashTaskSet,
	type ManifestEvaluation,
	type ManifestSelection,
	type RunManifest,
	writeRunManifest,
} from "./manifest.ts";
import {
	buildReport,
	type InstanceResult,
	type ReportPaths,
	writeReport,
} from "./report.ts";
import { BENCHMARK_RUNTIME } from "./runtime-profile.ts";
import { runOfficialEvaluation } from "./swebench/evaluate.ts";
import { loadInstances, selectInstances } from "./swebench/instances.ts";
import {
	type PredictionEntry,
	writePredictions,
} from "./swebench/predictions.ts";
import {
	CheckoutWorkspaceProvider,
	capturePatch,
} from "./swebench/workspace.ts";
import { reportBenchmarkRun } from "./telemetry.ts";

// 只在 patch-only 档位追加：约束与 report 里的 patchOnly 来自同一个运行档，
// 不允许出现「prompt 要求别装依赖，报告却说跑了完整 agent」这种不一致。
const BENCH_PROMPT_SUFFIX =
	"\n\nYou are running in an offline benchmark. Only modify files in the repository to fix the issue. Do not install dependencies, do not run the repository test suite, and do not commit. Leave your changes in the working tree.";

export async function runBenchCli(argv: string[]): Promise<number> {
	let command: ReturnType<typeof parseBenchArgs>;
	try {
		command = parseBenchArgs(argv);
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(err.message);
			console.error(BENCH_USAGE);
			return 1;
		}
		throw err;
	}

	if (command.suite === "help") {
		console.log(BENCH_USAGE);
		return 0;
	}

	try {
		return command.suite === "swebench"
			? await runSwebenchSuite(command)
			: await runCustomSuite(command);
	} catch (err) {
		console.error(
			`bench failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
}

async function runSwebenchSuite(command: SwebenchCommand): Promise<number> {
	const settings = loadSettings();
	const modelTier = resolveModelTier(settings.mainAgentTier, command.modelTier);
	const outputDir = resolveOutputDir(command.output, "swebench");
	await mkdir(outputDir, { recursive: true });

	const allInstances = await loadInstances(command.instancesFile);
	const instances = selectInstances(allInstances, {
		limit: command.limit,
		instanceIds: command.instanceIds,
		seed: command.seed,
	});
	if (instances.length === 0) {
		console.error("no instances selected");
		return 1;
	}

	const runId = `bench-${timestamp()}-${randomUUID().slice(0, 8)}`;
	const workspaceRoot = command.workspaceRoot ?? join(outputDir, "workspaces");
	const provider = new CheckoutWorkspaceProvider({
		cacheRoot: join(outputDir, "cache"),
		workspaceRoot,
	});

	// 先落 running 版清单：跑批中途被杀时，目录里能看出「这次条件是什么、没有跑完」，
	// 而不是只留下一堆无法判断来源的 report。
	const startedMs = Date.now();
	const manifest = await createManifest({
		runId,
		suite: "swebench",
		startedMs,
		settings,
		modelTier,
		selection: {
			dataset: command.dataset,
			split: command.split,
			seed: command.seed,
			...(command.limit === undefined ? {} : { limit: command.limit }),
			count: instances.length,
			idsHash: hashStrings(instances.map((instance) => instance.instance_id)),
		},
		eval: {
			mode: command.evalMode,
			maxWorkers: command.maxWorkers,
			...(command.evalMode === "remote" ? { host: command.evalHost } : {}),
		},
	});
	await writeRunManifest(manifest, outputDir);

	const promptSuffix = BENCHMARK_RUNTIME.patchOnly ? BENCH_PROMPT_SUFFIX : "";
	const results: InstanceResult[] = [];
	const predictions: PredictionEntry[] = [];
	for (let index = 0; index < instances.length; index += 1) {
		const instance = instances[index];
		if (instance === undefined) {
			continue;
		}
		const started = Date.now();
		let inputTokens = 0;
		let outputTokens = 0;
		let tokensByTier: InstanceResult["tokensByTier"];
		let patch = "";
		let error: string | undefined;
		let workspace: Awaited<ReturnType<typeof provider.prepare>> | undefined;

		try {
			workspace = await provider.prepare(instance);
			const turn = await runAgentTurn({
				cwd: workspace.cwd,
				prompt: `${instance.problem_statement}${promptSuffix}`,
				settings,
				modelTier,
			});
			inputTokens = turn.inputTokens;
			outputTokens = turn.outputTokens;
			tokensByTier = turn.tokensByTier;
			if (turn.outcome !== "success") {
				error = `agent ${turn.outcome}: ${turn.error ?? "unknown"}`;
			}
			patch = await capturePatch(workspace.cwd);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			if (workspace !== undefined) {
				try {
					await workspace.cleanup();
				} catch {
					// 清理失败不覆盖该题结果
				}
			}
		}

		predictions.push({ instanceId: instance.instance_id, patch });
		results.push({
			instanceId: instance.instance_id,
			passed: false,
			durationMs: Date.now() - started,
			inputTokens,
			outputTokens,
			...(tokensByTier === undefined ? {} : { tokensByTier }),
			...(error === undefined ? {} : { error }),
		});
		console.log(
			`[${index + 1}/${instances.length}] ${instance.instance_id} ${
				patch === "" ? "empty-patch" : "patch"
			} tokens=${inputTokens}/${outputTokens} ${(results[results.length - 1]?.durationMs ?? 0) / 1000}s${
				error === undefined ? "" : ` error=${error}`
			}`,
		);
	}

	const predictionsPath = join(outputDir, "predictions.jsonl");
	await writePredictions(predictionsPath, predictions);

	const official = await runOfficialEvaluation({
		mode: command.evalMode,
		host: command.evalHost,
		dataset: command.dataset,
		split: command.split,
		predictionsPath,
		maxWorkers: command.maxWorkers,
		runId,
		reportDir: join(outputDir, "official"),
		cwd: process.cwd(),
	});

	const completed = finalizeRunManifest(manifest, {
		status: "completed",
		finishedAt: new Date().toISOString(),
		durationMs: Date.now() - startedMs,
	});
	const report = buildReport(results, official, {
		suite: "swebench",
		dataset: command.dataset,
		split: command.split,
		manifest: completed,
	});
	await writeRunManifest(completed, outputDir);
	const paths = await writeReport(report, outputDir);
	await reportTelemetry(settings, report, {
		benchmark: "swebench",
		dataset: command.dataset,
		split: command.split,
	});
	printSummary(report, paths);
	return 0;
}

async function runCustomSuite(command: CustomCommand): Promise<number> {
	const settings = loadSettings();
	const modelTier = resolveModelTier(settings.mainAgentTier, command.modelTier);
	const outputDir = resolveOutputDir(command.output, "custom");
	await mkdir(outputDir, { recursive: true });

	const tasksDir = fileURLToPath(new URL("./custom/tasks/", import.meta.url));
	const allTasks = await loadCustomTasks(tasksDir);
	const tasks =
		command.domain === undefined
			? allTasks
			: allTasks.filter((task) => task.domain === command.domain);
	if (tasks.length === 0) {
		console.error(`no custom tasks for domain ${command.domain ?? "(all)"}`);
		return 1;
	}

	const startedMs = Date.now();
	const manifest = await createManifest({
		runId: `bench-${timestamp()}-${randomUUID().slice(0, 8)}`,
		suite: "custom",
		startedMs,
		settings,
		modelTier,
		selection: {
			count: tasks.length,
			idsHash: hashStrings(tasks.map((task) => task.id)),
			// 题面或校验脚本改动会让旧基线失效，必须能被检测到
			tasksetHash: hashTaskSet(tasks),
		},
	});
	await writeRunManifest(manifest, outputDir);

	const results: InstanceResult[] = [];
	const workspaceRoot = join(outputDir, "workspaces");
	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index];
		if (task === undefined) {
			continue;
		}
		const result = await runCustomTask(task, {
			workspaceRoot,
			runAgent: async ({ cwd, prompt, timeoutMs }) => {
				const turn = await runAgentTurn({
					cwd,
					prompt,
					settings,
					modelTier,
					timeoutMs,
				});
				return {
					inputTokens: turn.inputTokens,
					outputTokens: turn.outputTokens,
					tokensByTier: turn.tokensByTier,
				};
			},
		});
		results.push({
			instanceId: result.id,
			passed: result.passed,
			durationMs: result.durationMs,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			...(result.tokensByTier === undefined
				? {}
				: { tokensByTier: result.tokensByTier }),
			...(result.error === undefined ? {} : { error: result.error }),
		});
		console.log(
			`[${index + 1}/${tasks.length}] ${result.id} ${result.passed ? "pass" : "fail"} tokens=${result.inputTokens}/${result.outputTokens} ${result.durationMs / 1000}s`,
		);
	}

	const completed = finalizeRunManifest(manifest, {
		status: "completed",
		finishedAt: new Date().toISOString(),
		durationMs: Date.now() - startedMs,
	});
	const report = buildReport(results, undefined, {
		suite: "custom",
		manifest: completed,
	});
	await writeRunManifest(completed, outputDir);
	const paths = await writeReport(report, outputDir);
	await reportTelemetry(settings, report, {
		benchmark: "custom",
		dataset: "custom",
		split: "offline",
	});
	printSummary(report, paths);
	return 0;
}

async function reportTelemetry(
	settings: ReturnType<typeof loadSettings>,
	report: ReturnType<typeof buildReport>,
	meta: { benchmark: string; dataset: string; split: string },
): Promise<void> {
	for (const instance of report.instances) {
		try {
			await reportBenchmarkRun(settings, {
				...instance,
				benchmark: meta.benchmark,
				dataset: meta.dataset,
				split: meta.split,
			});
		} catch {
			// 遥测是旁路：单条失败不影响报告与退出码
		}
	}
}

function printSummary(
	report: ReturnType<typeof buildReport>,
	paths: ReportPaths,
): void {
	const input = report.tokens.input;
	console.log(
		`${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(1)}%), input tokens mean ${input.mean.toFixed(1)} median ${input.median.toFixed(1)} p90 ${input.p90.toFixed(1)}, duration median ${(report.durationMs.median / 1000).toFixed(1)}s`,
	);
	console.log(`report: ${paths.jsonPath}`);
	console.log(`markdown: ${paths.markdownPath}`);
}

interface CreateManifestInput {
	runId: string;
	suite: BenchmarkSuite;
	startedMs: number;
	settings: ReturnType<typeof loadSettings>;
	modelTier: ModelTier;
	selection: ManifestSelection;
	eval?: ManifestEvaluation;
}

async function createManifest(
	input: CreateManifestInput,
): Promise<RunManifest> {
	return createRunManifest({
		runId: input.runId,
		suite: input.suite,
		startedAt: new Date(input.startedMs).toISOString(),
		agent: await collectAgentFacts(process.cwd()),
		models: collectModelFingerprints(input.settings.models),
		mainAgentTier: input.modelTier,
		runtime: BENCHMARK_RUNTIME,
		selection: input.selection,
		...(input.eval === undefined ? {} : { eval: input.eval }),
	});
}

function resolveModelTier(
	settingsTier: ModelTier | undefined,
	cliTier: ModelTier | undefined,
): ModelTier {
	return cliTier ?? settingsTier ?? "high";
}

function resolveOutputDir(output: string | undefined, suite: string): string {
	if (output !== undefined) {
		return isAbsolute(output) ? output : resolve(process.cwd(), output);
	}
	return join(process.cwd(), "benchmark-runs", `${timestamp()}-${suite}`);
}

// yyyymmdd-hhmmss，本地时间，仅用于目录/run id 的可读排序
function timestamp(): string {
	const now = new Date();
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const invokedPath = process.argv[1];
if (
	invokedPath !== undefined &&
	fileURLToPath(import.meta.url) === invokedPath
) {
	const code = await runBenchCli(process.argv.slice(2));
	process.exitCode = code;
}
