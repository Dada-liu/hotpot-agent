import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ApprovalChain,
	type ApprovalDecision,
	type ApprovalRequest,
} from "../src/approval/chain.ts";
import {
	bashTool,
	DANGEROUS_COMMAND_PATTERNS,
	isDangerousCommand,
} from "../src/tools/bash.ts";
import type { ToolContext } from "../src/tools/tool.ts";

// 命令统一在临时目录下执行，保证测试 hermetic；approval 注入固定决策的 handler 并记录请求
let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-bash-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeCtx(decision?: ApprovalDecision): {
	ctx: ToolContext;
	requests: ApprovalRequest[];
} {
	const requests: ApprovalRequest[] = [];
	const approval = new ApprovalChain();
	if (decision !== undefined) {
		approval.use(async (req) => {
			requests.push(req);
			return decision;
		});
	}
	return {
		ctx: {
			cwd: dir,
			signal: new AbortController().signal,
			approval,
			agentId: "main",
			session: {
				id: "bash-test-session",
				filePath: `${dir}/session.jsonl`,
				append: async () => {},
			},
		},
		requests,
	};
}

describe("bashTool.execute", () => {
	it("echo hi：content 含 stdout 与 exit code 0，isError 为假，且不触发审批", async () => {
		const { ctx, requests } = makeCtx("deny");
		const out = await bashTool.execute({ command: "echo hi" }, ctx);

		expect(out.isError).toBeFalsy();
		expect(out.content).toContain("hi");
		expect(out.content).toContain("exit code: 0");
		// 安全命令即使 approval 链会 deny 也不应询问
		expect(requests).toHaveLength(0);
	});

	it("stderr 一并收进 content", async () => {
		const { ctx } = makeCtx();
		const out = await bashTool.execute(
			{ command: "echo out; echo err >&2" },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(out.content).toContain("out");
		expect(out.content).toContain("err");
	});

	it("非零退出码：isError 且 content 含 exit code", async () => {
		const { ctx } = makeCtx();
		const out = await bashTool.execute({ command: "exit 3" }, ctx);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("exit code: 3");
	});

	it("超时：sleep 5 + timeoutMs 200，kill 后 isError 且 content 含 timeout", async () => {
		const { ctx } = makeCtx();
		const start = Date.now();
		const out = await bashTool.execute(
			{ command: "sleep 5", timeoutMs: 200 },
			ctx,
		);

		expect(Date.now() - start).toBeLessThan(3000);
		expect(out.isError).toBe(true);
		expect(out.content).toContain("timeout");
	});

	it("AbortSignal 触发时 kill 进程：isError 且快速返回", async () => {
		const controller = new AbortController();
		const ctx: ToolContext = {
			cwd: dir,
			signal: controller.signal,
			approval: new ApprovalChain(),
			agentId: "main",
			session: {
				id: "bash-test-session",
				filePath: `${dir}/session.jsonl`,
				append: async () => {},
			},
		};
		const start = Date.now();
		const promise = bashTool.execute({ command: "sleep 5" }, ctx);
		setTimeout(() => controller.abort(), 100);
		const out = await promise;

		expect(Date.now() - start).toBeLessThan(3000);
		expect(out.isError).toBe(true);
		expect(out.content).toContain("abort");
	});

	it("超长输出：stdout 截断到尾部 30000 字符并在头部标注", async () => {
		const { ctx } = makeCtx();
		const out = await bashTool.execute(
			{ command: "printf 'x%.0s' {1..40000}" },
			ctx,
		);

		expect(out.isError).toBeFalsy();
		expect(out.content).toContain("truncated");
		// 尾部恰好保留 30000 个 x：存在 30000 连排，不存在 30001 连排
		expect(out.content).toMatch(/x{30000}/);
		expect(out.content).not.toMatch(/x{30001}/);
	});

	it("高危命令（rm -rf）审批 deny：不执行、isError，summary 含完整命令", async () => {
		const victim = join(dir, "victim-deny");
		await mkdir(victim, { recursive: true });
		await writeFile(join(victim, "keep.txt"), "keep");
		const command = `rm -rf ${victim}`;
		const { ctx, requests } = makeCtx("deny");

		const out = await bashTool.execute({ command }, ctx);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("denied");
		// deny 时命令未执行，文件仍在
		expect(existsSync(join(victim, "keep.txt"))).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0].kind).toBe("command");
		expect(requests[0].summary).toContain(command);
	});

	it("高危命令审批 allow：正常执行", async () => {
		const victim = join(dir, "victim-allow");
		await mkdir(victim, { recursive: true });
		await writeFile(join(victim, "keep.txt"), "keep");
		const { ctx, requests } = makeCtx("allow");

		const out = await bashTool.execute({ command: `rm -rf ${victim}` }, ctx);

		expect(out.isError).toBeFalsy();
		expect(existsSync(victim)).toBe(false);
		expect(requests).toHaveLength(1);
	});
});

describe("DANGEROUS_COMMAND_PATTERNS", () => {
	it("覆盖控制器给出的高危样例", () => {
		const dangerous = [
			"rm -rf /tmp/x",
			"rm -r /tmp/x",
			"mkfs.ext4 /dev/sda1",
			"dd if=/dev/zero of=disk.img",
			"echo x > /dev/sda",
			"shutdown -h now",
			"reboot",
			"git push origin main --force",
			":(){ :|:& };:",
		];
		for (const c of dangerous) {
			expect(isDangerousCommand(c), c).toBe(true);
		}
	});

	it("rm 递归删除的旗标变体全部命中：组合旗标、r 在前、长选项", () => {
		// 旧正则 /rm\s+-rf?/ 只认 r 在前的单一写法，这些变体曾绕过审批直接执行
		const dangerous = [
			"rm -fr /tmp/x",
			"rm -R /tmp/x",
			"rm --recursive --force /tmp/x",
			"rm -frv ~",
		];
		for (const c of dangerous) {
			expect(isDangerousCommand(c), c).toBe(true);
		}
	});

	it("常规命令不误判", () => {
		const safe = ["ls -la", "echo hi", "git push origin main", "cat /dev/null"];
		for (const c of safe) {
			expect(isDangerousCommand(c), c).toBe(false);
		}
	});

	it("正则表集中导出为常量，便于后续扩充", () => {
		expect(Array.isArray(DANGEROUS_COMMAND_PATTERNS)).toBe(true);
		expect(DANGEROUS_COMMAND_PATTERNS.length).toBeGreaterThanOrEqual(7);
	});
});
