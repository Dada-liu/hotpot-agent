// `pnpm bench` 入口：swebench 走「实例 → worktree → 无交互 agent → patch → 官方评测 → 报告」，
// custom 走「三类种子任务 → 无交互 agent → 本地校验 → 报告」。
// CLI 只做编排与日志；评分全部交给官方 swebench harness。
// 失败语义：参数错误/评测失败返回非 0；通过率不足 100% 仍是正常结束（benchmark 本来就允许失败题）。

import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, type ModelTier } from "@hotpot/core";
import { runAgentTurn } from "./agent-runner.ts";
import {
	BENCH_USAGE,
	type CustomCommand,
	type DoctorCommand,
	type MergeCommand,
	parseBenchArgs,
	type SwebenchCommand,
	UsageError,
} from "./cli-args.ts";
import { runCustomTask } from "./custom/runner.ts";
import { loadCustomTasks } from "./custom/task.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import {
	type BenchmarkSuite,
	collectAgentFacts,
	collectModelFingerprints,
	createRunManifest,
	describeManifestDiff,
	finalizeRunManifest,
	hashStrings,
	hashTaskSet,
	MANIFEST_FILE,
	type ManifestEvaluation,
	type ManifestSelection,
	manifestForComparison,
	type RunManifest,
	readRunManifest,
	writeRunManifest,
} from "./manifest.ts";
import { mergeRunDirs } from "./merge.ts";
import {
	type BenchmarkReport,
	buildReport,
	type InstanceResult,
	REPORT_FILE,
	type ReportPaths,
	type TelemetryDelivery,
	writeReport,
} from "./report.ts";
import { BENCHMARK_RUNTIME } from "./runtime-profile.ts";
import { applyShard, formatShard } from "./shard.ts";
import { type BenchSuite, loadBenchSuite } from "./suites.ts";
import {
	type OfficialReport,
	runOfficialEvaluation,
} from "./swebench/evaluate.ts";
import {
	loadInstances,
	type SwebenchInstance,
	selectInstances,
} from "./swebench/instances.ts";
import {
	PREDICTIONS_FILE,
	type PredictionEntry,
	predictionsFileName,
	readPredictions,
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
		switch (command.suite) {
			case "swebench":
				return await runSwebenchSuite(command);
			case "custom":
				return await runCustomSuite(command);
			case "merge":
				return await runMergeCommand(command);
			case "doctor":
				return await runDoctorCommand(command);
		}
	} catch (err) {
		console.error(
			`bench failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
}

// merge：把分片目录合成一轮。不做评测、不调模型，只做「可比性校验 + 合并 + 重算指标」。
async function runMergeCommand(command: MergeCommand): Promise<number> {
	const runId = `merged-${timestamp()}-${randomUUID().slice(0, 8)}`;
	const { paths, report, inputs } = await mergeRunDirs(command.dirs, {
		outputDir: command.output,
		runId,
	});
	console.log(
		`merged ${inputs.length} run(s) -> ${report.total} instances, ${report.passed} passed (${(report.passRate * 100).toFixed(1)}%)`,
	);
	if (report.manifest.status !== "completed") {
		console.error(
			"warning: 有分片没跑完，合并结果 status=running —— 现在还不能拿它出结论",
		);
	}
	console.log(`report: ${paths.jsonPath}`);
	console.log(`markdown: ${paths.markdownPath}`);
	return 0;
}

// doctor：只读预检。任何 fail 都以非 0 退出，方便放进 CI 或跑批脚本的入口。
async function runDoctorCommand(command: DoctorCommand): Promise<number> {
	const settings = loadSettings();
	const modelTier = resolveModelTier(settings.mainAgentTier, command.modelTier);
	const report = await runDoctor({
		cwd: process.cwd(),
		settings,
		modelTier,
		instancesFile: command.instancesFile,
		evalMode: command.evalMode,
		evalHost: command.evalHost,
		// 只探测「能不能写」：doctor 不该顺手建一个假的跑批目录
		outputDir: command.output ?? join(process.cwd(), "benchmark-runs"),
		checkNetwork: !command.offline,
	});
	console.log(formatDoctorReport(report));
	return report.failed === 0 ? 0 : 1;
}

async function runSwebenchSuite(command: SwebenchCommand): Promise<number> {
	const settings = loadSettings();
	const modelTier = resolveModelTier(settings.mainAgentTier, command.modelTier);
	const outputDir = resolveOutputDir(command.output, "swebench");
	await mkdir(outputDir, { recursive: true });

	const allInstances = await loadInstances(command.instancesFile);
	// 默认套件只决定「跑哪些题」：没给 --limit 也没给 --instance-ids 时用固定 10 题。
	// 用 id 清单而不是 --limit 10，才能保证换一份实例文件后仍然是同一批题，前后可配对。
	const suite =
		command.instanceIds === undefined && command.limit === undefined
			? await loadBenchSuite()
			: undefined;
	const selected = selectSelection(allInstances, command, suite);
	// 分片在「父集合」之上切：idsHash 记的是全量选择，parentIdsHash 让 merge 能认亲
	const instances = applyShard(selected, command.shard);
	if (instances.length === 0) {
		console.error(
			command.shard === undefined
				? "no instances selected"
				: `shard ${formatShard(command.shard)} 里没有实例（父集合只有 ${selected.length} 题，分片数太多）`,
		);
		return 1;
	}

	const resumed = await loadResumeState(
		outputDir,
		command.resume,
		command.repeat,
	);
	const runId = resumed?.manifest.runId ?? newRunId();
	const workspaceRoot = command.workspaceRoot ?? join(outputDir, "workspaces");
	const provider = new CheckoutWorkspaceProvider({
		cacheRoot: join(outputDir, "cache"),
		workspaceRoot,
	});

	// 先落 running 版清单：跑批中途被杀时，目录里能看出「这次条件是什么、没有跑完」，
	// 而不是只留下一堆无法判断来源的 report。
	const startedMs = resumed?.startedMs ?? Date.now();
	const manifest = await createManifest({
		runId,
		suite: "swebench",
		startedMs,
		settings,
		modelTier,
		repeat: command.repeat,
		selection: {
			dataset: command.dataset,
			split: command.split,
			seed: command.seed,
			...(command.limit === undefined ? {} : { limit: command.limit }),
			count: instances.length,
			idsHash: hashStrings(instances.map((instance) => instance.instance_id)),
			...(command.shard === undefined
				? {}
				: {
						shard: command.shard,
						parentIdsHash: hashStrings(
							selected.map((instance) => instance.instance_id),
						),
						parentCount: selected.length,
					}),
		},
		eval: {
			mode: command.evalMode,
			maxWorkers: command.maxWorkers,
			...(command.evalMode === "remote" ? { host: command.evalHost } : {}),
		},
	});
	if (resumed !== undefined) {
		// 续跑只允许在「同一实验条件」上继续：否则报告会把两次不同的跑批混成一条
		const diffs = describeManifestDiff(
			manifestForComparison(resumed.manifest),
			manifest,
		);
		if (diffs.length > 0) {
			console.error(
				`--resume 拒绝继续：${outputDir} 里的跑批与本次条件不同\n  ${diffs.join("\n  ")}`,
			);
			return 1;
		}
	}
	await writeRunManifest(manifest, outputDir);

	const promptSuffix = BENCHMARK_RUNTIME.patchOnly ? BENCH_PROMPT_SUFFIX : "";
	// resume 的键是 (instance, attempt)：重复跑批里「a 题的第 2 次」和「b 题的第 1 次」
	// 是两条独立结果，只按 instanceId 去重会把它们混成一条。
	// 官方 verdict 从 report 搬过来，patch 从 predictions 搬过来（否则合并后的预测会缺题）。
	const doneResults = new Map<string, InstanceResult>(
		(resumed?.report?.instances ?? []).map((result) => [
			progressKey(result.instanceId, result.attempt ?? 1),
			result,
		]),
	);
	const donePatches = new Map<string, string>();
	for (const [attempt, entries] of resumed?.predictions ?? []) {
		for (const entry of entries) {
			donePatches.set(progressKey(entry.instanceId, attempt), entry.patch);
		}
	}

	const results: InstanceResult[] = [];
	const officials: (OfficialReport | undefined)[] = [];
	let reusedCount = 0;

	for (let attempt = 1; attempt <= command.repeat; attempt += 1) {
		const fresh: PredictionEntry[] = [];
		const freshPatches = new Map<string, string>();
		const reused: InstanceResult[] = [];
		for (let index = 0; index < instances.length; index += 1) {
			const instance = instances[index];
			if (instance === undefined) {
				continue;
			}
			const key = progressKey(instance.instance_id, attempt);
			const done = doneResults.get(key);
			if (done !== undefined) {
				results.push(done);
				reused.push(done);
				reusedCount += 1;
				continue;
			}
			const started = Date.now();
			let inputTokens = 0;
			let outputTokens = 0;
			let tokensByTier: InstanceResult["tokensByTier"];
			let agentOutcome: InstanceResult["agentOutcome"];
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
				agentOutcome = turn.outcome;
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

			fresh.push({ instanceId: instance.instance_id, attempt, patch });
			freshPatches.set(instance.instance_id, patch);
			const result: InstanceResult = {
				instanceId: instance.instance_id,
				attempt,
				passed: false,
				durationMs: Date.now() - started,
				inputTokens,
				outputTokens,
				...(tokensByTier === undefined ? {} : { tokensByTier }),
				...(agentOutcome === undefined ? {} : { agentOutcome }),
				...(error === undefined ? {} : { error }),
			};
			results.push(result);
			console.log(
				`[a${attempt} ${index + 1}/${instances.length}] ${instance.instance_id} ${
					patch === "" ? "empty-patch" : "patch"
				} tokens=${inputTokens}/${outputTokens} ${result.durationMs / 1000}s${
					error === undefined ? "" : ` error=${error}`
				}`,
			);
		}

		// 每轮一个 predictions 文件：官方 harness 按 instance_id 建索引，
		// 同一题在一个文件里出现两次会互相覆盖，k 次尝试必须分开评测。
		const attemptDir = join(outputDir, "official", `attempt-${attempt}`);
		const predictionsPath = join(outputDir, predictionsFileName(attempt));
		await writePredictions(
			predictionsPath,
			patchEntries(instances, attempt, freshPatches, donePatches),
		);

		// 评测只跑本轮新跑的题：resume 的价值是「不重跑已完成的」，
		// 全量重评测会把省下的 agent 时间全部还回去。
		const evalPredictionsPath =
			reused.length === 0
				? predictionsPath
				: join(attemptDir, "pending-predictions.jsonl");
		if (reused.length > 0 && fresh.length > 0) {
			await writePredictions(evalPredictionsPath, fresh);
		}
		const official =
			fresh.length === 0
				? undefined
				: await runOfficialEvaluation({
						mode: command.evalMode,
						host: command.evalHost,
						dataset: command.dataset,
						split: command.split,
						predictionsPath: evalPredictionsPath,
						maxWorkers: command.maxWorkers,
						// 每次尝试是官方 harness 的一次独立 run，run id 必须唯一
						runId: `${runId}-a${attempt}`,
						reportDir: attemptDir,
						cwd: process.cwd(),
					});
		officials.push(combineOfficial(runId, reused, official));
	}

	if (reusedCount > 0) {
		console.log(
			`resume: 复用 ${reusedCount} 条已完成尝试，本次新跑 ${results.length - reusedCount} 条`,
		);
	}

	const completed = finalizeRunManifest(manifest, {
		status: "completed",
		finishedAt: new Date().toISOString(),
		durationMs: Date.now() - startedMs,
	});
	const report = buildReport(
		results,
		officials.every((official) => official === undefined)
			? undefined
			: officials,
		{
			suite: "swebench",
			dataset: command.dataset,
			split: command.split,
			manifest: completed,
		},
	);
	await writeRunManifest(completed, outputDir);
	const paths = await writeReport(report, outputDir);
	const delivery = await reportTelemetry(settings, report, completed, {
		benchmark: "swebench",
		dataset: command.dataset,
		split: command.split,
	});
	if (delivery !== undefined) {
		report.telemetry = delivery;
		// 先落一次报告再上报：即使进程在收尾阶段被杀，报告也已经在盘上；
		// 上报结果补写回去，是为了让「丢了多少条」在产物里可查。
		await writeReport(report, outputDir);
		logTelemetry(delivery);
	}
	printSummary(report, paths);
	return 0;
}

// 默认套件要求实例文件里包含这 10 题：缺题时给一条能照做的提示，
// 而不是只抛 "unknown instance id(s)" 让人猜这 10 个 id 从哪来。
function selectSelection(
	allInstances: SwebenchInstance[],
	command: SwebenchCommand,
	suite: BenchSuite | undefined,
): SwebenchInstance[] {
	try {
		return selectInstances(allInstances, {
			limit: command.limit,
			instanceIds: command.instanceIds ?? suite?.instanceIds,
			seed: command.seed,
		});
	} catch (err) {
		if (suite === undefined) {
			throw err;
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`${message}\n默认套件 ${suite.name} 需要这 ${suite.instanceIds.length} 道题：先用 scripts/export_instances.py 导出 ${suite.dataset}/${suite.split}，或显式传 --limit / --instance-ids。`,
		);
	}
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
	const runId = `bench-${timestamp()}-${randomUUID().slice(0, 8)}`;
	const manifest = await createManifest({
		runId,
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
					agentOutcome: turn.outcome,
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
			...(result.agentOutcome === undefined
				? {}
				: { agentOutcome: result.agentOutcome }),
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
	const delivery = await reportTelemetry(settings, report, completed, {
		benchmark: "custom",
		dataset: "custom",
		split: "offline",
	});
	if (delivery !== undefined) {
		report.telemetry = delivery;
		await writeReport(report, outputDir);
		logTelemetry(delivery);
	}
	printSummary(report, paths);
	return 0;
}

// 一轮一条 batch，把 manifest 里的可比条件随结果一起送到远端：
// 远端按 runId 把 N 条 benchmark_run 合成「一轮」，才谈得上与别的轮次比较。
// 发送失败不改变退出码，但必须把投递结果带给调用方——静默丢数是上一版最大的问题。
async function reportTelemetry(
	settings: ReturnType<typeof loadSettings>,
	report: ReturnType<typeof buildReport>,
	manifest: RunManifest,
	meta: { benchmark: string; dataset: string; split: string },
): Promise<TelemetryDelivery | undefined> {
	const model = manifest.models[manifest.mainAgentTier];
	try {
		return await reportBenchmarkRun(
			settings,
			{
				runId: manifest.runId,
				benchmark: meta.benchmark,
				dataset: meta.dataset,
				split: meta.split,
				...(manifest.agent.git.commit === null
					? {}
					: { commit: manifest.agent.git.commit }),
				...(manifest.agent.git.dirty === null
					? {}
					: { commitDirty: manifest.agent.git.dirty }),
				model: `${model.provider}/${model.model}`,
				tier: manifest.mainAgentTier,
				patchOnly: manifest.runtime.patchOnly,
				...(manifest.selection.tasksetHash === undefined
					? {}
					: { tasksetHash: manifest.selection.tasksetHash }),
			},
			report.instances,
		);
	} catch {
		// 遥测是旁路：任何异常都不影响报告与退出码
		return undefined;
	}
}

function newRunId(): string {
	return `bench-${timestamp()}-${randomUUID().slice(0, 8)}`;
}

interface ResumeState {
	manifest: RunManifest;
	report?: BenchmarkReport;
	// 按尝试序号分组的预测：重复跑批里每次尝试各有一个文件
	predictions: Map<number, PredictionEntry[]>;
	startedMs: number;
}

// resume 的语义：接着上次的 runId 往下跑，只补没跑完的 (instance, attempt)。
// 上次没走完收尾（没有 report）时仍复用 runId —— 否则「同一批题」会变成两轮互不相干的结果，
// 远端也无法把它们看成一件事。
async function loadResumeState(
	outputDir: string,
	enabled: boolean,
	repeat: number,
): Promise<ResumeState | undefined> {
	if (!enabled) {
		return undefined;
	}
	let manifest: RunManifest;
	try {
		manifest = await readRunManifest(join(outputDir, MANIFEST_FILE));
	} catch {
		console.log(`resume: ${outputDir} 里没有可复用的 manifest，按新跑批开始`);
		return undefined;
	}
	let report: BenchmarkReport | undefined;
	try {
		report = JSON.parse(
			await readFile(join(outputDir, REPORT_FILE), "utf8"),
		) as BenchmarkReport;
	} catch {
		console.log(
			"resume: manifest 在但 report 缺失（上次没走完收尾），所有题都会重跑",
		);
	}
	const predictions = new Map<number, PredictionEntry[]>();
	for (let attempt = 1; attempt <= repeat; attempt += 1) {
		const entries = await readPredictions(
			join(outputDir, predictionsFileName(attempt)),
		);
		if (entries.length > 0) {
			predictions.set(attempt, entries);
			continue;
		}
		if (attempt === 1) {
			// 旧目录只有 predictions.jsonl：只当作第 1 次尝试，其余尝试重跑
			const legacy = await readPredictions(join(outputDir, PREDICTIONS_FILE));
			if (legacy.length > 0) {
				predictions.set(1, legacy);
			}
		}
	}
	return {
		manifest,
		...(report === undefined ? {} : { report }),
		predictions,
		startedMs: Date.parse(manifest.startedAt),
	};
}

// 一次尝试的 official 由两部分组成：复用来的 verdict + 本次新评测的 verdict。
// 只传本次评测会让复用的题一律判 fail（它们的 patch 这一轮根本没重跑）。
function combineOfficial(
	runId: string,
	previous: readonly InstanceResult[],
	current: OfficialReport | undefined,
): OfficialReport | undefined {
	if (current === undefined && previous.length === 0) {
		return undefined;
	}
	return {
		runId,
		resolved: [
			...previous.filter((r) => r.passed).map((r) => r.instanceId),
			...(current?.resolved ?? []),
		],
		unresolved: [
			...previous.filter((r) => !r.passed).map((r) => r.instanceId),
			...(current?.unresolved ?? []),
		],
		emptyPatch: [...(current?.emptyPatch ?? [])],
	};
}

function logTelemetry(delivery: TelemetryDelivery): void {
	if (!delivery.enabled) {
		return;
	}
	const line = `telemetry: ${delivery.sent}/${delivery.events} events delivered in ${delivery.batches} batch(es)`;
	if (delivery.failed > 0) {
		console.error(`${line}, ${delivery.failed} failed`);
		return;
	}
	console.log(line);
}

function printSummary(
	report: ReturnType<typeof buildReport>,
	paths: ReportPaths,
): void {
	const input = report.tokens.input;
	const repeat = report.repeat;
	// repeat>1 时把「每轮通过率」直接打出来：单看均值会把波动藏起来
	const spread =
		repeat.attempts > 1
			? `, attempts ${repeat.passRateByAttempt.map((rate) => `${(rate * 100).toFixed(1)}%`).join("/")} (range ${(repeat.passRateMin * 100).toFixed(1)}%~${(repeat.passRateMax * 100).toFixed(1)}%, flaky ${repeat.flakyInstances})`
			: ", single attempt (no variance estimate)";
	console.log(
		`${report.resolvedInstances}/${report.total} instances resolved, pass rate ${(report.passRate * 100).toFixed(1)}%${spread}, input tokens mean ${input.mean.toFixed(1)} median ${input.median.toFixed(1)} p90 ${input.p90.toFixed(1)}, duration median ${(report.durationMs.median / 1000).toFixed(1)}s`,
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
	repeat?: number;
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
		...(input.repeat === undefined ? {} : { repeat: input.repeat }),
		...(input.eval === undefined ? {} : { eval: input.eval }),
	});
}

// resume 的去重键：同一题的不同尝试是独立结果，不能只按 instanceId 合并
function progressKey(instanceId: string, attempt: number): string {
	return `${instanceId}#${attempt}`;
}

// 该 attempt 的完整预测：新跑优先，其次复用；两者都没有的题不写入。
// 「跑过但 patch 为空」必须写空串——官方 harness 会把它记为 empty patch，
// 直接跳过则会被当成「没跑过」，题数对不上。
// 导出是为了单测：这个函数决定「哪些题会被送进官方 harness」，
// 空 patch 丢失或跨尝试串用都会让通过率失真，但不值得为它跑一次真实评测。
export function patchEntries(
	instances: readonly SwebenchInstance[],
	attempt: number,
	freshPatches: ReadonlyMap<string, string>,
	donePatches: ReadonlyMap<string, string>,
): PredictionEntry[] {
	const entries: PredictionEntry[] = [];
	for (const instance of instances) {
		const patch =
			freshPatches.get(instance.instance_id) ??
			donePatches.get(progressKey(instance.instance_id, attempt));
		if (patch === undefined) {
			continue;
		}
		entries.push({ instanceId: instance.instance_id, attempt, patch });
	}
	return entries;
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
