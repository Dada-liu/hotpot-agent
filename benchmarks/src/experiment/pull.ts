// 远端遥测回读：按台账里的 runId 把服务端数据拉回来，和本地 report.json 逐项对账。
//
// 这不是「把数字搬到另一个地方展示」。上报链路会丢事件（限流、网络、批次失败），
// 本地 report.json 里的 telemetry.dropped 只说明「投递失败了多少」，不说明服务端
// 最终落了多少。对账要回答的是：决策依据的这份远端数据，是不是完整、是不是同一轮。
//
// 对账不改写任何跑批结论；不一致只报 mismatch，由人决定要不要重拉/重跑。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	QueryWindow,
	RemoteBenchmarkRun,
	RemoteRunDetail,
} from "../telemetry-read.ts";
import { defaultQueryWindow } from "../telemetry-read.ts";
import { type RunArtifacts, readRunArtifacts } from "./compare.ts";
import { experimentPaths, readRegistry, saveExperiment } from "./ledger.ts";
import type { RecordLogger } from "./record.ts";
import type {
	ExperimentRecord,
	ExperimentTelemetry,
	ExperimentTelemetryRun,
} from "./types.ts";

export interface BenchmarkReadSource {
	readonly endpoint: string;
	benchmarkRuns(window: QueryWindow): Promise<RemoteBenchmarkRun[]>;
	benchmarkRunDetail(
		runId: string,
		window: QueryWindow,
	): Promise<RemoteRunDetail>;
}

export interface PullInput {
	mainRoot: string;
	record: ExperimentRecord;
	source: BenchmarkReadSource;
	window?: QueryWindow;
	now: () => Date;
	log: RecordLogger;
	// 默认写台账与明细文件；诊断时可以只看输出
	save?: boolean;
	// --json 时关掉人读表格，只留机器可读输出
	quiet?: boolean;
}

export interface RunCheck {
	variant: string;
	runId: string;
	status: "ok" | "missing" | "mismatch";
	local: {
		instances: number;
		attempts: number;
		passed: number;
		passRate: number;
		resolvedInstances: number;
		flakyInstances: number;
		flakyIds: string[];
		telemetryDropped: number | null;
	};
	remote: RemoteBenchmarkRun | null;
	detail: {
		instances: number;
		flakyIds: string[];
		truncated: boolean;
	} | null;
	diffs: string[];
	warnings: string[];
}

export interface PullResult {
	code: number;
	window: QueryWindow;
	checks: RunCheck[];
	telemetry: ExperimentTelemetry;
	record: ExperimentRecord;
}

export async function pullExperiment(input: PullInput): Promise<PullResult> {
	const { log } = input;
	const paths = experimentPaths(input.mainRoot, input.record.slug);
	if (input.record.runs.length === 0) {
		throw new Error(
			`${input.record.slug} 还没有登记跑批：先 pnpm exp run ${input.record.slug}（或手动 record），台账里要有 runId 才能回读`,
		);
	}
	const window =
		input.window ??
		defaultQueryWindow(
			input.record.runs.map((run) => run.recordedAt),
			input.now(),
		);
	const pulledAt = input.now().toISOString();

	const remoteRuns = await input.source.benchmarkRuns(window);
	const byId = new Map(remoteRuns.map((run) => [run.runId, run]));
	const checks: RunCheck[] = [];
	for (const run of input.record.runs) {
		let artifacts: RunArtifacts;
		try {
			artifacts = await readRunArtifacts(run.dir);
		} catch (err) {
			throw new Error(
				`本地跑批目录读不出来（${run.dir}）：${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const report = artifacts.report;
		const repeat = Math.max(artifacts.manifest.repeat ?? 1, 1);
		const flakyIds = report.perInstance
			.filter((item) => item.flaky)
			.map((item) => item.instanceId);
		const local: RunCheck["local"] = {
			instances: report.total,
			attempts: report.total * repeat,
			passed: report.passed,
			passRate: report.passRate,
			resolvedInstances: report.resolvedInstances,
			flakyInstances: flakyIds.length,
			flakyIds,
			telemetryDropped: report.telemetry?.dropped ?? null,
		};
		const remote = byId.get(run.runId) ?? null;
		const diffs: string[] = [];
		const warnings: string[] = [];
		if (remote === null) {
			diffs.push(
				`远端查不到 runId ${run.runId}（窗口 ${window.from} ~ ${window.to}）：遥测可能关闭、上报失败或事件落在窗口外`,
			);
		} else {
			compareNumber("题数", local.instances, remote.instances, diffs);
			compareNumber("尝试数", local.attempts, remote.attempts, diffs);
			compareNumber("通过次数", local.passed, remote.passed, diffs);
			if (
				remote.passRate === null ||
				Math.abs(remote.passRate / 100 - local.passRate) > 0.005
			) {
				diffs.push(
					`通过率 本地 ${(local.passRate * 100).toFixed(2)}% / 远端 ${remote.passRate === null ? "n/a" : `${remote.passRate.toFixed(2)}%`}`,
				);
			}
			compareNumber(
				"至少通过一次的题数",
				local.resolvedInstances,
				remote.resolvedInstances,
				diffs,
			);
			compareNumber(
				"flaky 题数",
				local.flakyInstances,
				remote.flakyInstances,
				diffs,
			);
		}
		if (local.telemetryDropped !== null && local.telemetryDropped > 0) {
			warnings.push(
				`本地报告记录有 ${local.telemetryDropped} 条遥测事件投递失败：远端数据大概率不完整`,
			);
		}

		let detail: RunCheck["detail"] = null;
		if (remote !== null) {
			try {
				const remoteDetail = await input.source.benchmarkRunDetail(
					run.runId,
					window,
				);
				const remoteFlaky = remoteDetail.instances
					.filter((item) => item.flaky)
					.map((item) => item.instanceId);
				detail = {
					instances: remoteDetail.instances.length,
					flakyIds: remoteFlaky,
					truncated: remoteDetail.truncated,
				};
				if (remoteDetail.truncated) {
					warnings.push(
						"远端逐题明细被截断（truncated=true），flaky 清单不完整",
					);
				}
				if (!sameSet(local.flakyIds, remoteFlaky) && !remoteDetail.truncated) {
					diffs.push(
						`flaky 题集合不一致：本地 [${local.flakyIds.join(", ")}] / 远端 [${remoteFlaky.join(", ")}]`,
					);
				}
			} catch (err) {
				warnings.push(
					`逐题明细拉取失败（不影响汇总对账）：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		checks.push({
			variant: run.variant,
			runId: run.runId,
			status:
				remote === null ? "missing" : diffs.length > 0 ? "mismatch" : "ok",
			local,
			remote,
			detail,
			diffs,
			warnings,
		});
	}

	const telemetry: ExperimentTelemetry = {
		pulledAt,
		endpoint: input.source.endpoint,
		window,
		runs: checks.map(toTelemetryRun),
	};
	const result: PullResult = {
		code: 0,
		window,
		checks,
		telemetry,
		record: input.record,
	};

	if (input.quiet !== true) {
		printTable(result, input.source.endpoint, log);
	}
	for (const check of checks) {
		for (const warning of check.warnings) {
			log.err(`warning: [${check.variant}] ${warning}`);
		}
		for (const diff of check.diffs) {
			log.err(`  [${check.variant}] ${diff}`);
		}
	}

	if (input.save === false) {
		log.out("未写台账（--no-save）：以上只是诊断输出");
		return result;
	}
	await mkdir(paths.runsRoot, { recursive: true });
	const detailPath = join(paths.runsRoot, "telemetry.json");
	await writeFile(
		detailPath,
		`${JSON.stringify({ ...telemetry, checks }, null, 2)}\n`,
	);
	const registry = await readRegistry(input.mainRoot);
	const next: ExperimentRecord = {
		...input.record,
		telemetry,
		updatedAt: pulledAt,
	};
	await saveExperiment(input.mainRoot, registry, next);
	result.record = next;
	log.out(`明细 ${detailPath}`);
	log.out(`台账已更新：docs/experiments/${input.record.slug}.md`);
	return result;
}

function toTelemetryRun(check: RunCheck): ExperimentTelemetryRun {
	return {
		variant: check.variant === "head" ? "head" : "base",
		runId: check.runId,
		status: check.status,
		attempts: check.remote?.attempts ?? null,
		passed: check.remote?.passed ?? null,
		passRate: check.remote?.passRate ?? null,
		resolvedInstances: check.remote?.resolvedInstances ?? null,
		flakyInstances: check.remote?.flakyInstances ?? null,
		diffs: check.diffs,
	};
}

function compareNumber(
	label: string,
	local: number,
	remote: number,
	diffs: string[],
): void {
	if (local !== remote) {
		diffs.push(`${label} 本地 ${local} / 远端 ${remote}`);
	}
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const set = new Set(a);
	return b.every((item) => set.has(item));
}

function printTable(
	result: PullResult,
	endpoint: string,
	log: RecordLogger,
): void {
	const { window, checks } = result;
	log.out(`远端回读：${endpoint}`);
	log.out(
		`  窗口 ${window.from} ~ ${window.to}（拉取于 ${result.telemetry.pulledAt}）`,
	);
	log.out("");
	const header = [
		"变体",
		"runId",
		"状态",
		"题数",
		"尝试",
		"通过",
		"通过率",
		"resolved",
		"flaky",
	];
	const rows = checks.map((check) => [
		check.variant,
		short(check.runId),
		check.status,
		`${check.local.instances}/${check.remote?.instances ?? "-"}`,
		`${check.local.attempts}/${check.remote?.attempts ?? "-"}`,
		`${check.local.passed}/${check.remote?.passed ?? "-"}`,
		`${(check.local.passRate * 100).toFixed(1)}%/${check.remote?.passRate === null || check.remote?.passRate === undefined ? "-" : `${check.remote.passRate.toFixed(1)}%`}`,
		`${check.local.resolvedInstances}/${check.remote?.resolvedInstances ?? "-"}`,
		`${check.local.flakyInstances}/${check.remote?.flakyInstances ?? "-"}`,
	]);
	const widths = header.map((title, index) =>
		Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
	);
	const line = (row: string[]): string =>
		row
			.map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
			.join("  ");
	log.out(line(header));
	for (const row of rows) {
		log.out(line(row));
	}
	log.out("");
	log.out(
		"表内数字为 本地/远端；状态 ok 表示逐项一致，mismatch/missing 需要人工判断。",
	);
	const bad = checks.filter((check) => check.status !== "ok").length;
	if (bad === 0) {
		log.out("结论：远端与本地报告一致，远端数据可以作为决策依据。");
	} else {
		log.err(
			`结论：${bad}/${checks.length} 轮对不上，先查上面的差异与 report.json 的 telemetry.dropped，再决定是否重跑`,
		);
	}
}

function short(value: string): string {
	return value.length > 14 ? value.slice(0, 14) : value;
}
