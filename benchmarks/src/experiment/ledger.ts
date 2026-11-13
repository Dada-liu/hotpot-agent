// 台账读写：docs/experiments/registry.json 是唯一事实源，<slug>.md 是它的人读视图。
//
// 为什么用 JSON 而不是 markdown frontmatter：台账要被命令反复读写，还要参与
// 「两组跑批是否可比」的判断。手写 YAML 解析器出错的代价是结论错，不是排版错。
// md 由记录渲染，顶部明确标注「生成文件」，避免有人手改后被覆盖还不知道。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	EXPERIMENT_SCHEMA_VERSION,
	type ExperimentRecord,
	type ExperimentRegistry,
	emptyRegistry,
	findRun,
} from "./types.ts";

export const EXPERIMENTS_DIR = "docs/experiments";
export const REGISTRY_NAME = "registry.json";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 48;

export function assertValidSlug(slug: string): string {
	if (!SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
		throw new Error(
			`slug 只能是小写字母/数字/连字符（如 ctx-budget），长度不超过 ${SLUG_MAX_LENGTH}：${slug}`,
		);
	}
	return slug;
}

export interface ExperimentPaths {
	// 相对主工作区的路径，写进台账，换机器仍然能读
	worktree: string;
	baseWorktree: string;
	branch: string;
	runsRoot: string;
	docPath: string;
}

// 所有路径都从主工作区推导：即使命令是在某个 worktree 里执行的，
// 台账与产物也不该跟着分支走。
export function experimentPaths(
	mainRoot: string,
	slug: string,
): ExperimentPaths {
	return {
		worktree: `.worktrees/${slug}`,
		baseWorktree: `.worktrees/${slug}-base`,
		branch: `exp/${slug}`,
		runsRoot: join(mainRoot, "benchmark-runs", "experiments", slug),
		docPath: join(mainRoot, EXPERIMENTS_DIR, `${slug}.md`),
	};
}

export function registryPath(mainRoot: string): string {
	return join(mainRoot, EXPERIMENTS_DIR, REGISTRY_NAME);
}

export async function readRegistry(
	mainRoot: string,
): Promise<ExperimentRegistry> {
	const path = registryPath(mainRoot);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return emptyRegistry();
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${path}: 不是合法 JSON`);
	}
	if (typeof value !== "object" || value === null) {
		throw new Error(`${path}: 顶层必须是对象`);
	}
	const registry = value as Partial<ExperimentRegistry>;
	if (registry.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
		throw new Error(
			`${path}: 期望 schemaVersion ${EXPERIMENT_SCHEMA_VERSION}，实际 ${String(registry.schemaVersion)}`,
		);
	}
	if (!Array.isArray(registry.experiments)) {
		throw new Error(`${path}: experiments 必须是数组`);
	}
	for (const record of registry.experiments) {
		if (typeof record.slug !== "string" || typeof record.status !== "string") {
			throw new Error(`${path}: 存在缺少 slug/status 的实验记录`);
		}
	}
	return registry as ExperimentRegistry;
}

export async function writeRegistry(
	mainRoot: string,
	registry: ExperimentRegistry,
): Promise<void> {
	const path = registryPath(mainRoot);
	await mkdir(dirname(path), { recursive: true });
	const ordered: ExperimentRegistry = {
		schemaVersion: EXPERIMENT_SCHEMA_VERSION,
		experiments: [...registry.experiments].sort((a, b) =>
			a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
		),
	};
	await writeFile(path, `${JSON.stringify(ordered, null, 2)}\n`);
}

export async function saveExperiment(
	mainRoot: string,
	registry: ExperimentRegistry,
	record: ExperimentRecord,
): Promise<ExperimentRegistry> {
	const exists = registry.experiments.some((item) => item.slug === record.slug);
	const next: ExperimentRegistry = {
		schemaVersion: EXPERIMENT_SCHEMA_VERSION,
		experiments: exists
			? registry.experiments.map((item) =>
					item.slug === record.slug ? record : item,
				)
			: [...registry.experiments, record],
	};
	await writeRegistry(mainRoot, next);
	await writeExperimentDoc(mainRoot, record);
	return next;
}

export async function writeExperimentDoc(
	mainRoot: string,
	record: ExperimentRecord,
): Promise<void> {
	const path = experimentPaths(mainRoot, record.slug).docPath;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, renderExperimentMarkdown(record));
}

export function renderExperimentMarkdown(record: ExperimentRecord): string {
	const base = findRun(record, "base");
	const head = findRun(record, "head");
	const lines: string[] = [];
	lines.push(`# ${record.title}`);
	lines.push("");
	lines.push(
		"> 本文件由 `pnpm exp` 生成，请勿手改；要改内容请用命令重写，否则下次写入会覆盖。",
	);
	lines.push("");
	lines.push("| 项 | 值 |");
	lines.push("|---|---|");
	lines.push(`| slug | \`${record.slug}\` |`);
	lines.push(`| 状态 | ${statusLabel(record.status)} |`);
	lines.push(`| 分支 | \`${record.branch}\` |`);
	lines.push(`| head worktree | \`${record.worktree}\` |`);
	lines.push(
		`| base worktree | ${record.baseWorktree === undefined ? "未创建（--no-base）" : `\`${record.baseWorktree}\``} |`,
	);
	lines.push(
		`| 基线 | \`${record.baseRef}\` @ \`${short(record.baseCommit)}\` |`,
	);
	lines.push(
		`| 套件 | \`${record.suite}\` × ${record.repeat} 次${record.modelTier === undefined ? "" : `，模型档位 ${record.modelTier}`} |`,
	);
	lines.push(`| 实例文件 | \`${record.instancesFile}\` |`);
	lines.push(`| 创建 | ${record.createdAt} |`);
	lines.push(`| 更新 | ${record.updatedAt} |`);
	if (record.closedAt !== undefined) {
		lines.push(`| 回收 | ${record.closedAt} |`);
	}
	lines.push("");

	if (record.requirement !== undefined) {
		lines.push("## 需求");
		lines.push("");
		lines.push(record.requirement);
		lines.push("");
	}

	lines.push("## 假设");
	lines.push("");
	lines.push(record.hypothesis);
	lines.push("");
	lines.push("## 指标");
	lines.push("");
	lines.push(`- 主指标：${record.primaryMetric}`);
	lines.push(`- 护栏指标：${record.guardrailMetric}`);
	lines.push(`- 回滚条件：${record.rollback}`);
	lines.push("");

	lines.push("## 跑批");
	lines.push("");
	if (record.runs.length === 0) {
		lines.push("尚未登记跑批。");
	} else {
		lines.push(
			"| 变体 | runId | 尝试级通过率 | 每轮通过率 | 每通过题 token | 提交 | 目录 |",
		);
		lines.push("|---|---|---|---|---|---|---|");
		for (const run of record.runs) {
			lines.push(
				`| ${run.variant} | \`${run.runId}\` | ${pct(run.passRate)}（${run.passed}/${run.total * Math.max(run.repeat, 1)} 次尝试） | ${run.passRateByAttempt.map((value) => pct(value)).join(" / ")} | ${run.tokensPerResolved === null ? "n/a" : Math.round(run.tokensPerResolved)} | \`${short(run.commit ?? "unknown")}\`${run.commitDirty === true ? " (dirty)" : ""} | \`${run.dir}\` |`,
			);
		}
		lines.push("");
		if (base !== undefined && head !== undefined) {
			lines.push(
				`基线自身波动：${pct(base.passRateMin)} ~ ${pct(base.passRateMax)}；候选自身波动：${pct(head.passRateMin)} ~ ${pct(head.passRateMax)}。`,
			);
		}
	}
	lines.push("");

	lines.push("## 对比");
	lines.push("");
	if (record.comparison === undefined) {
		lines.push(
			"尚未对比：需要 base 与 head 两轮都登记（`pnpm exp record <slug> --variant base|head`）。",
		);
	} else {
		const comparison = record.comparison;
		lines.push(`- 结论：**${comparison.verdict}**`);
		lines.push(`- 差异：${signedPp(comparison.deltaPp)}`);
		lines.push(
			`- 判定阈值（自身极差与单题刻度取大）：${comparison.noisePp.toFixed(1)}pp`,
		);
		lines.push(
			`- 逐题翻转：变好 ${comparison.improved} / 变差 ${comparison.regressed} / 不变 ${comparison.unchanged}`,
		);
		if (comparison.costDeltaPct !== null) {
			lines.push(
				`- 每通过题 token 变化：${comparison.costDeltaPct > 0 ? "+" : ""}${comparison.costDeltaPct.toFixed(1)}%`,
			);
		}
		lines.push(`- 方法：${comparison.method}（未做配对显著性检验）`);
		if (comparison.reasons.length > 0) {
			lines.push("");
			for (const reason of comparison.reasons) {
				lines.push(`> ${reason}`);
			}
		}
	}
	lines.push("");

	lines.push("## 决策");
	lines.push("");
	if (record.decision === undefined) {
		lines.push("尚未决策。");
	} else {
		lines.push(`- 结论：**${record.decision.verdict}**`);
		lines.push(`- 理由：${record.decision.note}`);
		lines.push(`- 时间：${record.decision.at}`);
		if (
			record.decision.comparison !== undefined &&
			record.decision.comparison.verdict !== "inconclusive" &&
			record.decision.verdict === "ship" &&
			record.decision.comparison.verdict === "worse"
		) {
			lines.push("- 注意：对比结论是 worse，决策仍选择上线。");
		}
	}
	lines.push("");

	lines.push("## 远端遥测回读");
	lines.push("");
	if (record.telemetry === undefined) {
		lines.push(
			"尚未回读：`pnpm exp pull <slug>` 会按台账里的 runId 拉取远端数据并与本地报告逐项对账。",
		);
	} else {
		const telemetry = record.telemetry;
		lines.push(
			`- 拉取时间：${telemetry.pulledAt}；服务：\`${telemetry.endpoint}\``,
		);
		lines.push(`- 查询窗口：${telemetry.window.from} ~ ${telemetry.window.to}`);
		lines.push("");
		lines.push(
			"| 变体 | runId | 对账 | 尝试 | 通过 | 通过率 | resolved | flaky |",
		);
		lines.push("|---|---|---|---|---|---|---|---|");
		for (const run of telemetry.runs) {
			lines.push(
				`| ${run.variant} | \`${run.runId}\` | ${run.status} | ${run.attempts ?? "-"} | ${run.passed ?? "-"} | ${run.passRate === null ? "-" : `${run.passRate.toFixed(2)}%`} | ${run.resolvedInstances ?? "-"} | ${run.flakyInstances ?? "-"} |`,
			);
		}
		const diffs = telemetry.runs.flatMap((run) =>
			run.diffs.map((diff) => `- ${run.variant}: ${diff}`),
		);
		if (diffs.length > 0) {
			lines.push("");
			lines.push("差异（远端数据不能直接当决策依据）：");
			lines.push(...diffs);
		} else {
			lines.push("");
			lines.push("逐项一致：远端数据与本地报告对得上。");
		}
	}
	lines.push("");

	lines.push("## 命令");
	lines.push("");
	lines.push("```bash");
	lines.push(
		`pnpm exp run ${record.slug}                 # 一条命令跑完两轮并登记`,
	);
	lines.push(
		`pnpm exp pull ${record.slug}                # 回读远端遥测并对账`,
	);
	lines.push(`pnpm exp show ${record.slug}`);
	lines.push(
		`pnpm exp record ${record.slug} --variant base   # 默认读 ${record.slug}/base`,
	);
	lines.push(`pnpm exp record ${record.slug} --variant head`);
	lines.push(`pnpm exp decide ${record.slug} --verdict ship --note "..."`);
	lines.push(`pnpm exp close ${record.slug}`);
	lines.push("```");
	lines.push("");
	return lines.join("\n");
}

function statusLabel(status: ExperimentRecord["status"]): string {
	switch (status) {
		case "open":
			return "进行中";
		case "decided":
			return "已决策";
		case "closed":
			return "已回收";
	}
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function signedPp(value: number): string {
	return `${value > 0 ? "+" : ""}${value.toFixed(1)}pp`;
}

function short(commit: string): string {
	return commit.length > 10 ? commit.slice(0, 10) : commit;
}
