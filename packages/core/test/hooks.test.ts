// hooks 生命周期链测试（M4 Feature③）：配置形状（Claude Code）、matcher、
// stdin payload、HOTPOT_HOOK_EVENT、阻断语义、超时 fail-open、hook/fired 落盘。
// 全部用临时目录里的真实 bash 命令，hermetic（不依赖网络/外部服务）。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HooksConfig } from "../src/config/config.ts";
import { createHookChain } from "../src/hooks/hooks.ts";
import type { SessionEvent } from "../src/session/events.ts";
import { createSession, loadSession } from "../src/session/store.ts";

let home: string;
let cwd: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-hooks-home-"));
	cwd = await mkdtemp(join(tmpdir(), "hotpot-hooks-cwd-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

// 单命令 hook 配置：event 为 Claude Code 键名
function config(
	key: keyof HooksConfig,
	command: string,
	matcher = "",
): HooksConfig {
	return { [key]: [{ matcher, hooks: [{ type: "command", command }] }] };
}

async function makeChain(cfg: HooksConfig | undefined, timeoutMs?: number) {
	const session = await createSession(cwd, home);
	const chain = createHookChain(cfg, {
		session,
		cwd,
		agentId: "main",
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	return { session, chain };
}

function firedEvents(
	events: SessionEvent[],
): Extract<SessionEvent, { type: "hook/fired" }>[] {
	return events.filter(
		(e): e is Extract<SessionEvent, { type: "hook/fired" }> =>
			e.type === "hook/fired",
	);
}

describe("PreToolUse 阻断语义", () => {
	it("matcher 命中且 exit≠0：blocked=true，输出进阻断原因，落 hook/fired", async () => {
		const { session, chain } = await makeChain(
			config("PreToolUse", "echo 'no bash allowed' >&2; exit 2", "bash"),
		);
		const result = await chain.run("pre_tool", {
			tool_name: "bash",
			tool_input: { command: "ls" },
		});
		expect(result.blocked).toBe(true);
		expect(result.output).toContain("no bash allowed");

		const { events } = await loadSession(session.filePath);
		const fired = firedEvents(events);
		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatchObject({
			hook: "pre_tool",
			command: "echo 'no bash allowed' >&2; exit 2",
			exitCode: 2,
			agentId: "main",
		});
		expect(fired[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("exit=0：不阻断，stdout 不进入阻断原因", async () => {
		const { chain } = await makeChain(
			config("PreToolUse", "echo checked", "bash"),
		);
		const result = await chain.run("pre_tool", { tool_name: "bash" });
		expect(result.blocked).toBe(false);
		expect(result.output).toBe("");
	});

	it("matcher 精确匹配工具名：read 配置不拦 bash", async () => {
		const { session, chain } = await makeChain(
			config("PreToolUse", "exit 1", "read"),
		);
		const result = await chain.run("pre_tool", { tool_name: "bash" });
		expect(result.blocked).toBe(false);
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)).toHaveLength(0);
	});

	it("matcher=* 匹配全部工具", async () => {
		const { chain } = await makeChain(config("PreToolUse", "exit 1", "*"));
		expect((await chain.run("pre_tool", { tool_name: "read" })).blocked).toBe(
			true,
		);
		expect((await chain.run("pre_tool", { tool_name: "bash" })).blocked).toBe(
			true,
		);
	});
});

describe("命令执行约定", () => {
	it("payload 经 stdin 喂 JSON，含 base 字段与事件特有字段", async () => {
		const out = join(cwd, "payload.json");
		const { session, chain } = await makeChain(
			config("PostToolUse", `cat > '${out}'`),
		);
		await chain.run("post_tool", {
			tool_name: "read",
			tool_input: { path: "a.ts" },
			tool_output: "file body",
			is_error: false,
			duration_ms: 7,
		});
		const payload = JSON.parse(await readFile(out, "utf8")) as Record<
			string,
			unknown
		>;
		expect(payload).toMatchObject({
			session_id: session.id,
			cwd,
			agent_id: "main",
			hook_event: "post_tool",
			tool_name: "read",
			tool_input: { path: "a.ts" },
			tool_output: "file body",
			is_error: false,
			duration_ms: 7,
		});
	});

	it("payload.agent_id 覆盖归属 agent（worker/task 工具钩子）", async () => {
		const { session, chain } = await makeChain(config("PostToolUse", "true"));
		await chain.run("post_tool", { agent_id: "worker-1", tool_name: "bash" });
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)[0]?.agentId).toBe("worker-1");
	});

	it("env 带 HOTPOT_HOOK_EVENT，cwd 为会话 cwd", async () => {
		const out = join(cwd, "env.txt");
		const { chain } = await makeChain(
			config(
				"PostToolUse",
				`printf '%s|%s' "$HOTPOT_HOOK_EVENT" "$PWD" > '${out}'`,
			),
		);
		await chain.run("post_tool", { tool_name: "read" });
		// macOS 的 mkdtemp 返回 /var/... 而 bash 的 PWD 是物理路径 /private/var/...：
		// 只断言事件名与目录尾段，避免符号链接前缀差异
		const text = await readFile(out, "utf8");
		expect(text.startsWith("post_tool|")).toBe(true);
		expect(text.endsWith(`/T/${cwd.split("/").at(-1)}`)).toBe(true);
	});

	it("多条命令按配置顺序执行", async () => {
		const out = join(cwd, "order.txt");
		const cfg: HooksConfig = {
			PostToolUse: [
				{
					matcher: "",
					hooks: [
						{ type: "command", command: `echo first >> '${out}'` },
						{ type: "command", command: `echo second >> '${out}'` },
					],
				},
			],
		};
		const { chain } = await makeChain(cfg);
		await chain.run("post_tool", { tool_name: "read" });
		expect((await readFile(out, "utf8")).trim().split("\n")).toEqual([
			"first",
			"second",
		]);
	});

	it("非预处理事件的非零退出不阻断，但照常落事件", async () => {
		const { session, chain } = await makeChain(config("PostToolUse", "exit 3"));
		const result = await chain.run("post_tool", { tool_name: "read" });
		expect(result.blocked).toBe(false);
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)[0]?.exitCode).toBe(3);
	});

	it("turn_end（Stop）忽略 matcher 一律执行", async () => {
		const { session, chain } = await makeChain(
			config("Stop", "exit 0", "startup"),
		);
		await chain.run("turn_end", { stop_reason: "stop" });
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)).toHaveLength(1);
		expect(firedEvents(events)[0]?.hook).toBe("turn_end");
	});

	it("超时 fail-open：exitCode=-1、不阻断、事件仍落盘", async () => {
		const { session, chain } = await makeChain(
			config("PreToolUse", "sleep 2", "bash"),
			50,
		);
		const started = Date.now();
		const result = await chain.run("pre_tool", { tool_name: "bash" });
		expect(Date.now() - started).toBeLessThan(1500);
		expect(result.blocked).toBe(false);
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)[0]?.exitCode).toBe(-1);
	});
});

describe("空配置", () => {
	it("未配置 hooks：不执行、不落事件", async () => {
		const { session, chain } = await makeChain(undefined);
		const result = await chain.run("pre_tool", { tool_name: "bash" });
		expect(result).toEqual({ blocked: false, output: "" });
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)).toHaveLength(0);
	});

	it("配置了事件但无匹配 matcher：不执行、不落事件", async () => {
		const { session, chain } = await makeChain(
			config("PreToolUse", "exit 1", "write"),
		);
		await chain.run("pre_tool", { tool_name: "read" });
		const { events } = await loadSession(session.filePath);
		expect(firedEvents(events)).toHaveLength(0);
	});
});
