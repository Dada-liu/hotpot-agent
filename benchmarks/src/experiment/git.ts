// git 操作的窄封装：只包实验脚手架需要的那几条命令。
//
// 约束：所有会改仓库状态的命令都必须由调用方传入「主工作区」路径。git worktree add
// 在链接 worktree 里执行时路径解析会跟着 cwd 走，一旦从错误的位置执行，会在
// .worktrees/ 里再套一层 .worktrees/。

import { realpath } from "node:fs/promises";
import { type CommandResult, runCommand } from "../process.ts";

const GIT_TIMEOUT_MS = 15_000;

export interface WorktreeEntry {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	bare: boolean;
}

export async function git(
	cwd: string,
	args: string[],
	timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<CommandResult> {
	return runCommand("git", args, { cwd, timeoutMs });
}

// 失败时把 git 自己的 stderr 带出来：不这样做，用户只会看到「命令失败」，
// 却不知道是「分支已存在」还是「路径非空」。
export async function gitOrThrow(
	cwd: string,
	args: string[],
	what: string,
): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim();
		throw new Error(
			`${what} 失败：git ${args.join(" ")}${detail === "" ? "" : `\n${detail}`}`,
		);
	}
	return result.stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const result = await git(cwd, ["rev-parse", "--git-dir"]);
	return result.code === 0;
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
	const output = await gitOrThrow(
		cwd,
		["worktree", "list", "--porcelain"],
		"读取 worktree 列表",
	);
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = {
				path: line.slice("worktree ".length),
				head: null,
				branch: null,
				detached: false,
				bare: false,
			};
			entries.push(current);
			continue;
		}
		if (current === undefined) {
			continue;
		}
		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			current.branch = line
				.slice("branch ".length)
				.replace(/^refs\/heads\//, "");
		} else if (line === "detached") {
			current.detached = true;
		} else if (line === "bare") {
			current.bare = true;
		}
	}
	return entries;
}

export interface RepoRoots {
	// 主工作区（git worktree list 的第一条）：台账与跑批产物都落在这里
	mainRoot: string;
	// 当前命令所在的工作区，可能是链接 worktree
	currentRoot: string;
	isMain: boolean;
}

export async function resolveRepo(cwd: string): Promise<RepoRoots> {
	const currentRoot = await gitOrThrow(
		cwd,
		["rev-parse", "--show-toplevel"],
		"定位仓库根目录",
	);
	const worktrees = await listWorktrees(cwd);
	const main = worktrees[0];
	if (main === undefined) {
		throw new Error(`git worktree list 没有返回任何工作区：${cwd}`);
	}
	const [a, b] = await Promise.all([
		realpath(main.path),
		realpath(currentRoot),
	]);
	return { mainRoot: a, currentRoot: b, isMain: a === b };
}

export async function resolveCommit(cwd: string, ref: string): Promise<string> {
	return gitOrThrow(
		cwd,
		["rev-parse", "--verify", `${ref}^{commit}`],
		`解析 ${ref}`,
	);
}

export async function branchExists(
	cwd: string,
	branch: string,
): Promise<boolean> {
	const result = await git(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${branch}`,
	]);
	return result.code === 0;
}

// 基线是否仍是候选的祖先：分支被 rebase 过就不再是「同一基线 + 一个改动」，
// 这时 base 与 head 的差异里混进了别人的提交，对比结论没有意义。
export async function isAncestor(
	cwd: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	const result = await git(cwd, [
		"merge-base",
		"--is-ancestor",
		ancestor,
		descendant,
	]);
	return result.code === 0;
}

export interface WorktreeState {
	commit: string | null;
	dirty: boolean;
}

export async function worktreeState(cwd: string): Promise<WorktreeState> {
	const commit = await git(cwd, ["rev-parse", "HEAD"]);
	const status = await git(cwd, ["status", "--porcelain"]);
	return {
		commit: commit.code === 0 ? commit.stdout.trim() : null,
		dirty: status.code === 0 ? status.stdout.trim() !== "" : true,
	};
}

export async function addWorktree(opts: {
	cwd: string;
	path: string;
	commit: string;
	branch?: string;
	detached: boolean;
}): Promise<void> {
	const args = ["worktree", "add"];
	if (opts.detached) {
		args.push("--detach", opts.path, opts.commit);
	} else {
		if (opts.branch === undefined) {
			throw new Error("非 detached 的 worktree 必须给分支名");
		}
		args.push("-b", opts.branch, opts.path, opts.commit);
	}
	await gitOrThrow(opts.cwd, args, "创建 worktree");
}

export async function removeWorktree(
	cwd: string,
	path: string,
	force: boolean,
): Promise<void> {
	const args = ["worktree", "remove"];
	if (force) {
		args.push("--force");
	}
	args.push(path);
	await gitOrThrow(cwd, args, "回收 worktree");
}

// worktree 目录被手动删掉后 git 仍留着登记，prune 才能让同一路径重新可建
export async function pruneWorktrees(cwd: string): Promise<void> {
	await git(cwd, ["worktree", "prune"]);
}
