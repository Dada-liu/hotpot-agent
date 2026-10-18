// WorkspaceProvider 与 patch 捕获测试：临时 git 仓库当远端，不触网。
// 断言：按 instance 建出独立 worktree；tracked 修改与 untracked 新文件都进 patch；
// node_modules 与 .hotpot 被排除；cleanup 后 worktree 目录与登记都消失。

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/index.ts";
import {
	CheckoutWorkspaceProvider,
	capturePatch,
} from "../src/swebench/workspace.ts";
import type { WorkspaceInstance } from "../src/workspace.ts";

let root: string;
let origin: string;
let cacheRoot: string;
let workspaceRoot: string;

async function git(args: string[], cwd: string): Promise<string> {
	const result = await runCommand("git", args, { cwd });
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hotpot-bench-workspace-"));
	origin = join(root, "origin");
	cacheRoot = join(root, "cache");
	workspaceRoot = join(root, "worktrees");
	await git(["init", "--initial-branch=main", origin], root);
	await git(["config", "user.email", "bench@example.com"], origin);
	await git(["config", "user.name", "bench"], origin);
	await writeFile(join(origin, "app.txt"), "original\n", "utf8");
	await git(["add", "-A"], origin);
	await git(["commit", "-m", "initial"], origin);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("CheckoutWorkspaceProvider", () => {
	it("prepare 建出 worktree，capturePatch 捕获修改与新文件并排除噪声目录", async () => {
		const baseCommit = (await git(["rev-parse", "HEAD"], origin)).trim();
		const instance: WorkspaceInstance = {
			instance_id: "fixture__repo-1",
			repo: "fixture/repo",
			base_commit: baseCommit,
		};
		const provider = new CheckoutWorkspaceProvider({
			cacheRoot,
			workspaceRoot,
			repoUrl: () => origin,
		});

		const workspace = await provider.prepare(instance);
		expect(workspace.cwd).toBe(join(workspaceRoot, instance.instance_id));
		expect(await readFile(join(workspace.cwd, "app.txt"), "utf8")).toBe(
			"original\n",
		);

		await writeFile(join(workspace.cwd, "app.txt"), "changed\n", "utf8");
		await writeFile(join(workspace.cwd, "new-file.txt"), "brand new\n", "utf8");
		await mkdir(join(workspace.cwd, "node_modules", "pkg"), {
			recursive: true,
		});
		await writeFile(
			join(workspace.cwd, "node_modules", "pkg", "index.js"),
			"x\n",
			"utf8",
		);
		await mkdir(join(workspace.cwd, ".hotpot"), { recursive: true });
		await writeFile(
			join(workspace.cwd, ".hotpot", "state.json"),
			"{}\n",
			"utf8",
		);

		const patch = await capturePatch(workspace.cwd);
		expect(patch).toContain("app.txt");
		expect(patch).toContain("+changed");
		expect(patch).toContain("new-file.txt");
		expect(patch).toContain("+brand new");
		expect(patch).not.toContain("node_modules");
		expect(patch).not.toContain(".hotpot");

		await workspace.cleanup();
		expect(existsSync(workspace.cwd)).toBe(false);
		const cacheRepo = join(cacheRoot, instance.repo);
		const list = await git(["worktree", "list", "--porcelain"], cacheRepo);
		expect(list).not.toContain(workspace.cwd);
	});

	it("base commit 不存在时 prepare 抛错且不留下工作目录", async () => {
		const instance: WorkspaceInstance = {
			instance_id: "fixture__repo-2",
			repo: "fixture/repo",
			base_commit: "0000000000000000000000000000000000000000",
		};
		const provider = new CheckoutWorkspaceProvider({
			cacheRoot,
			workspaceRoot,
			repoUrl: () => origin,
		});

		await expect(provider.prepare(instance)).rejects.toThrow();
		expect(existsSync(join(workspaceRoot, instance.instance_id))).toBe(false);
	});
});
