import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveMessages } from "../src/session/derive.ts";
import type { SessionEvent } from "../src/session/events.ts";
import {
	createSession,
	listSessions,
	loadSession,
	resumeSession,
} from "../src/session/store.ts";

// 每个用例一个临时 home，隔离文件系统；home 参数优先于 HOTPOT_HOME 环境变量
let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-session-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

// 固定时间戳与 id，保证测试确定性
let seq = 0;
function nextId(): string {
	seq += 1;
	return `evt-${seq}`;
}

const TS = "2026-10-10T08:00:00.000Z";

function userMsg(text: string): SessionEvent {
	return {
		type: "user_msg",
		id: nextId(),
		ts: TS,
		agentId: "main",
		content: text,
	};
}

function assistantText(text: string): SessionEvent {
	return {
		type: "assistant_msg",
		id: nextId(),
		ts: TS,
		agentId: "main",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5 },
		model: "test-model",
		tier: "high",
	};
}

// 追加 meta 之外的 4 个事件：user_msg / assistant_msg（含 tool_call）/ tool_result / assistant_msg（纯文本）
async function appendConversation(session: {
	append(e: SessionEvent): Promise<void>;
}): Promise<void> {
	await session.append(userMsg("帮我看一下目录"));
	await session.append({
		type: "assistant_msg",
		id: nextId(),
		ts: TS,
		agentId: "main",
		content: [
			{ type: "text", text: "我先列一下目录" },
			{ type: "tool_call", id: "tc-1", name: "bash", input: { command: "ls" } },
		],
		usage: { input: 20, output: 8 },
		model: "test-model",
		tier: "high",
	});
	await session.append({
		type: "tool_result",
		id: nextId(),
		ts: TS,
		agentId: "main",
		toolCallId: "tc-1",
		content: "a.txt\nb.txt",
		isError: false,
	});
	await session.append(assistantText("目录里有两个文件"));
}

describe("session store", () => {
	it("createSession 落盘 meta 事件，路径按规则编码", async () => {
		const session = await createSession("/Users/test/project", home);
		// cwd 编码：/ 与 : 替换为 -
		expect(session.filePath).toBe(
			join(
				home,
				"sessions",
				"-Users-test-project",
				`${session.filePath.split("/").pop()}`,
			),
		);
		const fileName = session.filePath.split("/").pop() ?? "";
		expect(fileName).toMatch(/^\d{8}-\d{6}_.+\.jsonl$/);
		expect(fileName.endsWith(`_${session.id}.jsonl`)).toBe(true);

		const { meta, events } = await loadSession(session.filePath);
		if (meta.type !== "meta") {
			throw new Error("meta event missing");
		}
		expect(meta).toEqual({
			type: "meta",
			sessionId: session.id,
			createdAt: meta.createdAt,
			cwd: "/Users/test/project",
			formatVersion: 1,
		});
		expect(typeof meta.createdAt).toBe("string");
		expect(events).toHaveLength(1);
	});

	it("home 参数优先于 HOTPOT_HOME，环境变量优先于默认目录", async () => {
		const envHome = await mkdtemp(join(tmpdir(), "hotpot-env-home-"));
		const oldEnv = process.env.HOTPOT_HOME;
		process.env.HOTPOT_HOME = envHome;
		try {
			// 无 home 参数时走环境变量
			const fromEnv = await createSession("/tmp/x");
			expect(fromEnv.filePath.startsWith(envHome)).toBe(true);
			// home 参数覆盖环境变量
			const fromParam = await createSession("/tmp/x", home);
			expect(fromParam.filePath.startsWith(home)).toBe(true);
		} finally {
			if (oldEnv === undefined) {
				delete process.env.HOTPOT_HOME;
			} else {
				process.env.HOTPOT_HOME = oldEnv;
			}
			await rm(envHome, { recursive: true, force: true });
		}
	});

	it("append 后可完整 loadSession；末尾半行损坏 JSON 被跳过", async () => {
		const session = await createSession("/Users/test/project", home);
		await appendConversation(session);

		const loaded = await loadSession(session.filePath);
		expect(loaded.events).toHaveLength(5); // meta + 4 个事件

		// 模拟崩溃：文件末尾追加半行损坏 JSON
		await appendFile(session.filePath, '{"type":"user_msg","id":"broken"');
		const afterCorrupt = await loadSession(session.filePath);
		expect(afterCorrupt.events).toHaveLength(5);
		expect(afterCorrupt.meta.type).toBe("meta");
	});

	it("listSessions 能找到刚创建的会话", async () => {
		const session = await createSession("/Users/test/project", home);
		const list = await listSessions(home);
		expect(list).toHaveLength(1);
		const summary = list[0];
		expect(summary?.id).toBe(session.id);
		expect(summary?.filePath).toBe(session.filePath);
		expect(summary?.cwd).toBe("/Users/test/project");
		expect(summary?.createdAt).toBeTruthy();
		// home 目录不存在时返回空列表
		expect(await listSessions(join(home, "not-exist"))).toEqual([]);
	});

	it("resumeSession 恢复已有会话并继续 append；文件不存在时抛错", async () => {
		const session = await createSession("/Users/test/project", home);
		await session.append(userMsg("第一条"));

		const resumed = await resumeSession(session.filePath);
		expect(resumed.id).toBe(session.id);
		expect(resumed.filePath).toBe(session.filePath);
		await resumed.append(assistantText("续聊回复"));

		const { events } = await loadSession(session.filePath);
		expect(events.map((e) => e.type)).toEqual([
			"meta",
			"user_msg",
			"assistant_msg",
		]);

		await expect(
			resumeSession(join(home, "not-exist.jsonl")),
		).rejects.toThrow();
	});
});

describe("deriveMessages", () => {
	it("折叠 5 个事件产出 4 条 Message，顺序与类型正确", async () => {
		const session = await createSession("/Users/test/project", home);
		await appendConversation(session);
		const { events } = await loadSession(session.filePath);
		expect(events).toHaveLength(5);

		const messages = deriveMessages(events, "main");
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "帮我看一下目录" }],
		});
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "我先列一下目录" },
				{
					type: "tool_call",
					id: "tc-1",
					name: "bash",
					input: { command: "ls" },
				},
			],
		});
		// tool_result 折叠为 role:"user" 消息承载 tool_result 块
		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					toolCallId: "tc-1",
					content: "a.txt\nb.txt",
					isError: false,
				},
			],
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "目录里有两个文件" }],
		});
	});

	it("只折叠指定 agentId 的事件；meta 等其余类型不进消息历史", async () => {
		const session = await createSession("/Users/test/project", home);
		await session.append(userMsg("主 agent 消息"));
		await session.append({
			type: "assistant_msg",
			id: nextId(),
			ts: TS,
			agentId: "worker-1",
			content: [{ type: "text", text: "子 agent 的回复" }],
			usage: { input: 1, output: 1 },
			model: "test-model",
			tier: "medium",
		});
		await session.append({
			type: "error",
			id: nextId(),
			ts: TS,
			agentId: "main",
			code: "test",
			message: "不应出现在历史里",
		});
		const { events } = await loadSession(session.filePath);

		const mainMessages = deriveMessages(events, "main");
		expect(mainMessages).toHaveLength(1);
		expect(mainMessages[0]?.role).toBe("user");

		const workerMessages = deriveMessages(events, "worker-1");
		expect(workerMessages).toHaveLength(1);
		expect(workerMessages[0]?.role).toBe("assistant");
	});

	it("连续的 tool_result 事件合并为一条 user 消息", async () => {
		const events: SessionEvent[] = [
			{
				type: "meta",
				sessionId: "s",
				createdAt: TS,
				cwd: "/x",
				formatVersion: 1,
			},
			{
				type: "assistant_msg",
				id: "a1",
				ts: TS,
				agentId: "main",
				content: [
					{ type: "tool_call", id: "tc-1", name: "bash", input: {} },
					{ type: "tool_call", id: "tc-2", name: "read", input: {} },
				],
				usage: { input: 1, output: 1 },
				model: "test-model",
				tier: "high",
			},
			{
				type: "tool_result",
				id: "r1",
				ts: TS,
				toolCallId: "tc-1",
				content: "one",
				isError: false,
			},
			{
				type: "tool_result",
				id: "r2",
				ts: TS,
				toolCallId: "tc-2",
				content: "two",
				isError: true,
			},
		];
		const messages = deriveMessages(events, "main");
		expect(messages).toHaveLength(2);
		expect(messages[1]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					toolCallId: "tc-1",
					content: "one",
					isError: false,
				},
				{
					type: "tool_result",
					toolCallId: "tc-2",
					content: "two",
					isError: true,
				},
			],
		});
	});
});
