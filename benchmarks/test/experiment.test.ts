// 实验脚手架的测试：全部在临时 git 仓库里跑，不碰真实 .worktrees。
// 覆盖的重点不是「命令能跑」，而是「拦得住」：重复 slug、基线漂移、
// 重复次数不一致、脏工作区回收，这些才是让结论失真的地方。

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExperimentCli } from "../src/experiment/cli.ts";
import { experimentPaths, registryPath } from "../src/experiment/ledger.ts";
import type { ExperimentRegistry } from "../src/experiment/types.ts";
import { MANIFEST_FILE, type RunManifest } from "../src/manifest.ts";
import { runCommand } from "../src/process.ts";
import { buildReport, REPORT_FILE } from "../src/report.ts";
import {
	makeManifest,
	TEST_AGENT_FACTS,
	TEST_MODELS,
} from "./helpers/manifest.ts";

const created: string[] = [];

afterEach(async () => {
	// 临时仓库里有 worktree 登记，直接删目录会留下无效登记；这里只清临时目录本身
	while (created.length > 0) {
		const dir = created.pop();
		if (dir === undefined) {
			continue;
		}
		await rm(dir, { recursive: true, force: true });
	}
});

async function makeRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hotpot-exp-"));
	created.push(dir);
	await git(dir, ["init", "-q", "-b", "main"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "test"]);
	await writeFile(join(dir, "README.md"), "# fixture\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await runCommand("git", args, { cwd });
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

interface CliRun {
	code: number;
	out: string;
	err: string;
}

async function run(cwd: string, argv: string[]): Promise<CliRun> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runExperimentCli(argv, {
		cwd,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		now: () => new Date("2026-11-13T02:00:00.000Z"),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

async function readRegistryOf(repo: string): Promise<ExperimentRegistry> {
	return JSON.parse(
		await readFile(registryPath(repo), "utf8"),
	) as ExperimentRegistry;
}

const IDS = Array.from(
	{ length: 10 },
	(_, index) => `django__django-${11000 + index}`,
);

interface FakeRunSpec {
	dir: string;
	commit: string;
	repeat: number;
	// 每道题通过的尝试次数，长度必须等于 IDS
	passedPerInstance: number[];
	runId?: string;
}

// 造一份结构合法的跑批目录：manifest + report 都走真实构造函数，
// 这样登记侧的校验（status/commit/repeat/idsHash）测的是真逻辑。
async function writeFakeRun(spec: FakeRunSpec): Promise<void> {
	await mkdir(spec.dir, { recursive: true });
	const manifest: RunManifest = makeManifest({
		suite: "swebench",
		repeat: spec.repeat,
		agent: { ...TEST_AGENT_FACTS, git: { commit: spec.commit, dirty: false } },
		models: TEST_MODELS,
		selection: {
			dataset: "SWE-bench/SWE-bench_Lite",
			split: "test",
			count: IDS.length,
			idsHash: "same-ids",
		},
	});
	const results = IDS.flatMap((instanceId, index) =>
		Array.from({ length: spec.repeat }, (_, attempt) => ({
			instanceId,
			attempt: attempt + 1,
			passed: attempt < (spec.passedPerInstance[index] ?? 0),
			durationMs: 1000,
			inputTokens: 100,
			outputTokens: 10,
		})),
	);
	const report = buildReport(results, undefined, {
		suite: "swebench",
		dataset: "SWE-bench/SWE-bench_Lite",
		split: "test",
		manifest,
	});
	await writeFile(
		join(spec.dir, MANIFEST_FILE),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	await writeFile(
		join(spec.dir, REPORT_FILE),
		`${JSON.stringify(report, null, 2)}\n`,
	);
}

describe("pnpm exp new", () => {
	it("建 head 分支 worktree、detached 基线 worktree、台账与文档", async () => {
		const repo = await makeRepo();
		const result = await run(repo, [
			"new",
			"ctx-budget",
			"--hypothesis",
			"给上下文加预算上限，能减少 max_tokens 失败",
			"--title",
			"上下文预算",
			"--requirement",
			"跑批里 max_tokens 占比 20%",
		]);
		expect(result.code).toBe(0);

		// 分支存在，且 head worktree 检出在该分支上
		expect(
			await git(repo, ["rev-parse", "--verify", "refs/heads/exp/ctx-budget"]),
		).not.toBe("");
		const headFile = await readFile(
			join(repo, ".worktrees/ctx-budget/README.md"),
			"utf8",
		);
		expect(headFile).toContain("fixture");
		expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
		const headBranch = await runCommand(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: join(repo, ".worktrees/ctx-budget") },
		);
		expect(headBranch.stdout.trim()).toBe("exp/ctx-budget");

		// 基线 worktree 是 detached：这样它永远停在 baseCommit 上
		const baseBranch = await runCommand(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: join(repo, ".worktrees/ctx-budget-base") },
		);
		expect(baseBranch.stdout.trim()).toBe("HEAD");

		const registry = await readRegistryOf(repo);
		expect(registry.experiments).toHaveLength(1);
		const record = registry.experiments[0];
		expect(record?.slug).toBe("ctx-budget");
		expect(record?.status).toBe("open");
		expect(record?.baseCommit).toBe(await git(repo, ["rev-parse", "HEAD"]));
		expect(record?.suite).toBe("lite10");
		expect(record?.repeat).toBe(3);
		expect(record?.hypothesis).toContain("上下文加预算");
		expect(record?.requirement).toContain("max_tokens");
		expect(record?.runs).toEqual([]);

		const doc = await readFile(
			experimentPaths(repo, "ctx-budget").docPath,
			"utf8",
		);
		expect(doc).toContain("上下文预算");
		expect(doc).toContain("回滚条件");
		expect(doc).toContain("pnpm exp record ctx-budget --variant base");

		// 下一步命令必须是可直接粘贴执行的：绝对路径产物 + 共用实例文件
		expect(result.out).toContain("pnpm install");
		expect(result.out).toContain("--repeat 3");
		expect(result.out).toContain("benchmark-runs/experiments/ctx-budget/base");
	});

	it("拒绝重复 slug，且不重复建目录", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "dup", "--hypothesis", "h"]);
		const second = await run(repo, ["new", "dup", "--hypothesis", "h"]);
		expect(second.code).toBe(1);
		expect(second.err).toContain("已在台账里");
		expect(await readRegistryOf(repo)).toMatchObject({
			experiments: [{ slug: "dup" }],
		});
	});

	it("缺少假设时直接失败，不建任何东西", async () => {
		const repo = await makeRepo();
		const result = await run(repo, ["new", "no-hypothesis"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("--hypothesis");
		const branches = await git(repo, ["branch", "--list", "exp/*"]);
		expect(branches).toBe("");
	});

	it("--dry-run 只打印计划", async () => {
		const repo = await makeRepo();
		const result = await run(repo, [
			"new",
			"dry",
			"--hypothesis",
			"h",
			"--dry-run",
		]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("[dry-run]");
		const branches = await git(repo, ["branch", "--list", "exp/*"]);
		expect(branches).toBe("");
	});

	it("slug 非法时拒绝", async () => {
		const repo = await makeRepo();
		const result = await run(repo, ["new", "Bad_Slug", "--hypothesis", "h"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("slug");
	});
});

describe("pnpm exp record", () => {
	it("两轮都登记后给出方向结论，并保留配对明细", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "faster-loop", "--hypothesis", "h"]);
		const commit = await git(repo, ["rev-parse", "HEAD"]);
		const paths = experimentPaths(repo, "faster-loop");
		// base 5/10 每题三次全过 → 每轮都是 50%，自身极差 0；head 10/10 → 100%
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		await writeFakeRun({
			dir: join(paths.runsRoot, "head"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map(() => 3),
		});

		const base = await run(repo, [
			"record",
			"faster-loop",
			"--variant",
			"base",
		]);
		expect(base.code).toBe(0);
		expect(base.out).toContain("另一变体尚未登记");
		const head = await run(repo, [
			"record",
			"faster-loop",
			"--variant",
			"head",
		]);
		expect(head.code).toBe(0);

		const record = (await readRegistryOf(repo)).experiments[0];
		expect(record?.runs).toHaveLength(2);
		expect(record?.comparison?.verdict).toBe("better");
		expect(record?.comparison?.deltaPp).toBeCloseTo(50, 1);
		// 极差都为 0，判定阈值落到单题刻度 10pp
		expect(record?.comparison?.noisePp).toBeCloseTo(10, 5);
		expect(record?.comparison?.improved).toBe(5);
		expect(record?.comparison?.regressed).toBe(0);
		expect(record?.comparison?.perInstance.at(-1)).toMatchObject({
			instanceId: IDS[9],
			basePassed: 0,
			headPassed: 3,
			attempts: 3,
		});
		expect(head.out).toContain("对比：better");
	});

	it("差异不超过单题刻度时给 inconclusive", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "one-instance", "--hypothesis", "h"]);
		const commit = await git(repo, ["rev-parse", "HEAD"]);
		const paths = experimentPaths(repo, "one-instance");
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		// 多对 1 题 = +10pp，正好等于单题刻度：不能算改进
		await writeFakeRun({
			dir: join(paths.runsRoot, "head"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 6 ? 3 : 0)),
		});
		await run(repo, ["record", "one-instance", "--variant", "base"]);
		const head = await run(repo, [
			"record",
			"one-instance",
			"--variant",
			"head",
		]);
		expect(head.code).toBe(0);
		const record = (await readRegistryOf(repo)).experiments[0];
		expect(record?.comparison?.verdict).toBe("inconclusive");
		expect(record?.comparison?.reasons.join(" ")).toContain("判定阈值");
	});

	it("基线提交漂移时拒绝登记", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "drift", "--hypothesis", "h"]);
		const paths = experimentPaths(repo, "drift");
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit: "0".repeat(40),
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		const result = await run(repo, ["record", "drift", "--variant", "base"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("基线已经漂移");
		expect((await readRegistryOf(repo)).experiments[0]?.runs).toEqual([]);
	});

	it("重复次数不一致时拒绝登记", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "k-mismatch", "--hypothesis", "h"]);
		const commit = await git(repo, ["rev-parse", "HEAD"]);
		const paths = experimentPaths(repo, "k-mismatch");
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit,
			repeat: 1,
			passedPerInstance: IDS.map(() => 1),
		});
		const result = await run(repo, [
			"record",
			"k-mismatch",
			"--variant",
			"base",
		]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("重复次数属于实验条件");
	});

	it("两轮条件不一致时拒绝登记", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "mixed", "--hypothesis", "h"]);
		const commit = await git(repo, ["rev-parse", "HEAD"]);
		const paths = experimentPaths(repo, "mixed");
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		await run(repo, ["record", "mixed", "--variant", "base"]);
		// head 的题集不同：idsHash 变化必须被拦住，否则比的是两套题
		await writeFakeRun({
			dir: join(paths.runsRoot, "head"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 8 ? 3 : 0)),
		});
		await rewriteSelectionHash(paths.runsRoot, "head", "other-ids");
		const result = await run(repo, ["record", "mixed", "--variant", "head"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("跑批条件不一致");
		expect(result.err).toContain("selected instances");
	});
});

describe("pnpm exp decide / close", () => {
	it("决策必须有理由，写下后状态变 decided 并带对比快照", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "decided", "--hypothesis", "h"]);
		const noNote = await run(repo, ["decide", "decided", "--verdict", "ship"]);
		expect(noNote.code).toBe(1);
		expect(noNote.err).toContain("--note");

		const result = await run(repo, [
			"decide",
			"decided",
			"--verdict",
			"no-ship",
			"--note",
			"成本上涨 40%，不值得",
		]);
		expect(result.code).toBe(0);
		const record = (await readRegistryOf(repo)).experiments[0];
		expect(record?.status).toBe("decided");
		expect(record?.decision?.verdict).toBe("no-ship");
		expect(record?.decision?.note).toContain("成本");
	});

	it("已决策的实验再登记跑批会被拦（inconclusive 除外）", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "final", "--hypothesis", "h"]);
		await run(repo, [
			"decide",
			"final",
			"--verdict",
			"ship",
			"--note",
			"review 通过",
		]);
		const commit = await git(repo, ["rev-parse", "HEAD"]);
		const paths = experimentPaths(repo, "final");
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		const result = await run(repo, ["record", "final", "--variant", "base"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("实验已决策");
	});

	it("close 回收两个 worktree 但保留分支", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "cleanup", "--hypothesis", "h"]);
		const result = await run(repo, ["close", "cleanup"]);
		expect(result.code).toBe(0);
		expect(pathExists(join(repo, ".worktrees/cleanup"))).toBe(false);
		expect(pathExists(join(repo, ".worktrees/cleanup-base"))).toBe(false);
		expect(
			await git(repo, ["rev-parse", "--verify", "refs/heads/exp/cleanup"]),
		).not.toBe("");
		const record = (await readRegistryOf(repo)).experiments[0];
		expect(record?.status).toBe("closed");
		expect(record?.closedAt).toBeDefined();
	});

	it("工作区不干净时拒绝回收", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "dirty", "--hypothesis", "h"]);
		await writeFile(join(repo, ".worktrees/dirty/README.md"), "# changed\n");
		const result = await run(repo, ["close", "dirty"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("未提交的改动");
		expect(pathExists(join(repo, ".worktrees/dirty"))).toBe(true);
	});
});

describe("pnpm exp list", () => {
	it("按台账列出实验及跑批进度", async () => {
		const repo = await makeRepo();
		await run(repo, ["new", "alpha", "--hypothesis", "h"]);
		const commit = await git(repo, ["rev-parse", "HEAD"]);
		const paths = experimentPaths(repo, "alpha");
		await writeFakeRun({
			dir: join(paths.runsRoot, "base"),
			commit,
			repeat: 3,
			passedPerInstance: IDS.map((_, index) => (index < 5 ? 3 : 0)),
		});
		await run(repo, ["record", "alpha", "--variant", "base"]);
		const result = await run(repo, ["list"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("alpha");
		expect(result.out).toContain("B·");
	});
});

// 改一份已生成跑批的题集哈希，用来构造「两边题目不同」的场景
async function rewriteSelectionHash(
	runsRoot: string,
	variant: string,
	idsHash: string,
): Promise<void> {
	const path = join(runsRoot, variant, MANIFEST_FILE);
	const manifest = JSON.parse(await readFile(path, "utf8")) as RunManifest;
	manifest.selection.idsHash = idsHash;
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function pathExists(path: string): boolean {
	return existsSync(path);
}
