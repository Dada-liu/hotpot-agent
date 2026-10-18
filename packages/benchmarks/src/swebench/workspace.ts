// SWE-bench 的 WorkspaceProvider 实现：仓库缓存 + 每题独立 git worktree。
// 缓存目录 <cacheRoot>/<repo>（repo 形如 owner/name）；首次 clone，之后 fetch。
// 每题执行 `git worktree add --detach <workspaceRoot>/<instance_id> <base_commit>`，
// 并发实例因此不会共享工作树；M5 不装依赖、不跑测试，只保证 git、源码与写权限。
// patch 由 `git add -A -N` + `git diff` 生成，显式排除 node_modules 与 .hotpot，
// 否则 agent 的临时产物会把预测污染成不可评分的巨型补丁。

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runCommand } from "../process.ts";
import type {
	Workspace,
	WorkspaceInstance,
	WorkspaceProvider,
} from "../workspace.ts";

const DEFAULT_CLONE_TIMEOUT_MS = 900000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CheckoutWorkspaceProviderOptions {
	cacheRoot: string;
	workspaceRoot: string;
	// 测试注入本地仓库路径；缺省按 GitHub HTTPS 地址拼
	repoUrl?: (repo: string) => string;
	cloneTimeoutMs?: number;
	commandTimeoutMs?: number;
}

export class CheckoutWorkspaceProvider implements WorkspaceProvider {
	private readonly cacheRoot: string;
	private readonly workspaceRoot: string;
	private readonly repoUrl: (repo: string) => string;
	private readonly cloneTimeoutMs: number;
	private readonly commandTimeoutMs: number;

	constructor(opts: CheckoutWorkspaceProviderOptions) {
		this.cacheRoot = opts.cacheRoot;
		this.workspaceRoot = opts.workspaceRoot;
		this.repoUrl = opts.repoUrl ?? ((repo) => `https://github.com/${repo}.git`);
		this.cloneTimeoutMs = opts.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
		this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	}

	async prepare(instance: WorkspaceInstance): Promise<Workspace> {
		if (!REPO_PATTERN.test(instance.repo)) {
			throw new Error(`invalid repository name: ${instance.repo}`);
		}
		const cacheRepo = join(this.cacheRoot, instance.repo);
		await this.ensureCache(instance.repo, cacheRepo);
		await mkdir(this.workspaceRoot, { recursive: true });

		const cwd = join(this.workspaceRoot, instance.instance_id);
		// 上次崩溃可能留下同名 worktree：先强制清掉再建，保证 prepare 幂等
		if (existsSync(cwd)) {
			await runCommand("git", ["worktree", "remove", "--force", cwd], {
				cwd: cacheRepo,
				timeoutMs: this.commandTimeoutMs,
			});
			await rm(cwd, { recursive: true, force: true });
			await runCommand("git", ["worktree", "prune"], {
				cwd: cacheRepo,
				timeoutMs: this.commandTimeoutMs,
			});
		}

		let added = await this.addWorktree(cacheRepo, cwd, instance.base_commit);
		if (added.code !== 0) {
			// base_commit 可能不在默认 fetch refspec 覆盖的分支上：显式拉一次再试。
			// 拉取失败也继续走下面的统一报错，避免把原始 stderr 拆成两条错误路径
			await runCommand("git", ["fetch", "origin", instance.base_commit], {
				cwd: cacheRepo,
				timeoutMs: this.commandTimeoutMs,
			});
			added = await this.addWorktree(cacheRepo, cwd, instance.base_commit);
		}
		if (added.code !== 0) {
			await rm(cwd, { recursive: true, force: true });
			throw new Error(
				`git worktree add failed for ${instance.instance_id}: ${lastLine(added.stderr)}`,
			);
		}

		return {
			cwd,
			cleanup: async () => {
				await runCommand("git", ["worktree", "remove", "--force", cwd], {
					cwd: cacheRepo,
					timeoutMs: this.commandTimeoutMs,
				});
				await runCommand("git", ["worktree", "prune"], {
					cwd: cacheRepo,
					timeoutMs: this.commandTimeoutMs,
				});
				await rm(cwd, { recursive: true, force: true });
			},
		};
	}

	private async ensureCache(repo: string, cacheRepo: string): Promise<void> {
		if (existsSync(join(cacheRepo, ".git"))) {
			const fetched = await runCommand("git", ["fetch", "--all", "--prune"], {
				cwd: cacheRepo,
				timeoutMs: this.cloneTimeoutMs,
			});
			if (fetched.code !== 0) {
				throw new Error(
					`git fetch failed for ${repo}: ${lastLine(fetched.stderr)}`,
				);
			}
			return;
		}
		await mkdir(dirname(cacheRepo), { recursive: true });
		// 半截缓存（clone 中断）没有 .git，必须先清掉，否则 git clone 会拒绝非空目录
		if (existsSync(cacheRepo)) {
			await rm(cacheRepo, { recursive: true, force: true });
		}
		const cloned = await runCommand(
			"git",
			["clone", this.repoUrl(repo), cacheRepo],
			{ cwd: this.cacheRoot, timeoutMs: this.cloneTimeoutMs },
		);
		if (cloned.code !== 0) {
			await rm(cacheRepo, { recursive: true, force: true });
			throw new Error(
				`git clone failed for ${repo}: ${lastLine(cloned.stderr)}`,
			);
		}
	}

	private addWorktree(
		cacheRepo: string,
		cwd: string,
		baseCommit: string,
	): Promise<{ code: number; stderr: string }> {
		return runCommand("git", ["worktree", "add", "--detach", cwd, baseCommit], {
			cwd: cacheRepo,
			timeoutMs: this.commandTimeoutMs,
		});
	}
}

// 捕获 patch：intent-to-add 让 untracked 文件进入 diff，同时用 pathspec 排除
// node_modules 与 .hotpot（add 阶段就排除，避免把大目录写进索引）。
// 空 patch 返回空串：空预测由官方 harness 记为 unresolved，不是运行错误。
export async function capturePatch(cwd: string): Promise<string> {
	const pathspec = [".", ":!node_modules", ":!.hotpot"];
	const added = await runCommand(
		"git",
		["add", "-A", "-N", "--", ...pathspec],
		{ cwd },
	);
	if (added.code !== 0) {
		throw new Error(`git add failed: ${lastLine(added.stderr)}`);
	}
	const diff = await runCommand(
		"git",
		["diff", "--no-color", "HEAD", "--", ...pathspec],
		{ cwd },
	);
	if (diff.code !== 0) {
		throw new Error(`git diff failed: ${lastLine(diff.stderr)}`);
	}
	return diff.stdout;
}

function lastLine(text: string): string {
	const lines = text.trim().split("\n");
	return lines[lines.length - 1] ?? text.trim();
}
