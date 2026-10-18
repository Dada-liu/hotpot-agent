// 自建题 runner 测试：临时 workspace + 假的 runAgent（不触网），
// 校验命令用 node 单行脚本，断言 passed / 退出码 / 捕获输出。

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentRunner,
	type CustomTask,
	runCustomTask,
} from "../src/index.ts";

let workspaceRoot: string;

beforeEach(async () => {
	workspaceRoot = await mkdtemp(join(tmpdir(), "hotpot-bench-custom-"));
});

afterEach(async () => {
	await rm(workspaceRoot, { recursive: true, force: true });
});

function makeTask(overrides: Partial<CustomTask> = {}): CustomTask {
	return {
		id: "fixture-task",
		domain: "software",
		prompt: "Create answer.txt with the expected content.",
		workspace: { files: { "input.txt": "hello\n" } },
		validation: { command: 'node -e "process.exit(0)"' },
		...overrides,
	};
}

describe("runCustomTask", () => {
	it("agent 写入预期文件且校验通过时 passed 为 true", async () => {
		const runAgent: AgentRunner = async ({ cwd }) => {
			await writeFile(join(cwd, "answer.txt"), "expected\n", "utf8");
			return { inputTokens: 12, outputTokens: 3 };
		};

		const result = await runCustomTask(makeTask(), { runAgent, workspaceRoot });

		expect(result).toMatchObject({
			id: "fixture-task",
			passed: true,
			exitCode: 0,
			inputTokens: 12,
			outputTokens: 3,
		});
		expect(result.error).toBeUndefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		// 默认清理 workspace，只留下临时根目录本身
		expect(await readdir(workspaceRoot)).toEqual([]);
	});

	it("校验失败时 passed 为 false 并返回退出码与输出", async () => {
		const runAgent: AgentRunner = async ({ cwd }) => {
			await writeFile(join(cwd, "answer.txt"), "wrong\n", "utf8");
			return { inputTokens: 5, outputTokens: 1 };
		};

		const result = await runCustomTask(
			makeTask({
				validation: {
					command:
						"node -e \"console.log('expected mismatch'); process.exit(1)\"",
				},
			}),
			{ runAgent, workspaceRoot },
		);

		expect(result.passed).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("expected mismatch");
	});

	it("agent 抛错时 passed 为 false 且 error 带原因", async () => {
		const runAgent: AgentRunner = async () => {
			throw new Error("adapter exploded");
		};

		const result = await runCustomTask(makeTask(), { runAgent, workspaceRoot });

		expect(result.passed).toBe(false);
		expect(result.exitCode).not.toBe(0);
		expect(result.error).toContain("adapter exploded");
	});
});
