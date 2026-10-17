// inbox 双队列测试：followup（next-turn FIFO）/ steer / inject（next-step）、
// 每个动词落盘一条 inbox/spliced 全量快照、foldInbox 从事件流转换恢复（模拟 kill 重启）、
// 消息 id 去重、cancel 调 onCancel。drain/poll 清空内存队列但不追加新快照事件。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, loadSession, type SessionEvent } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInbox, foldInbox } from "../src/inbox.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-inbox-home-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

// 从会话文件读出全部事件（drain 后复查落盘条数用）
async function loadEvents(filePath: string): Promise<SessionEvent[]> {
	const { events } = await loadSession(filePath);
	return events;
}

describe("createInbox 双队列语义", () => {
	it("followup×2 + steer×1：drainNextTurn FIFO 且清空，pollNextStep 取 steer 内容", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("第一条");
		await inbox.followup("第二条");
		await inbox.steer("中途转向");

		const nextTurn = await inbox.drainNextTurn();
		expect(nextTurn.map((m) => m.content)).toEqual(["第一条", "第二条"]);
		expect(
			nextTurn.every((m) => typeof m.id === "string" && m.id.length > 0),
		).toBe(true);

		// 取空：再次 drain 返回空数组
		expect(await inbox.drainNextTurn()).toEqual([]);

		// next-step 不受影响；pollNextStep 返回字符串内容并清空
		expect(await inbox.pollNextStep()).toEqual(["中途转向"]);
		expect(await inbox.pollNextStep()).toEqual([]);
		expect(await inbox.drainNextTurn()).toEqual([]);
	});

	it("inject 与 steer 数据路径一致：进入 next-step 并可被 pollNextStep 取出", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.inject("静默补充");
		expect(await inbox.pollNextStep()).toEqual(["静默补充"]);
	});

	it("每个动词各落盘一条 inbox/spliced，messages 为该队列全量快照", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("a");
		await inbox.followup("b");
		await inbox.steer("c");

		const events = await loadEvents(session.filePath);
		const spliced = events.filter((e) => e.type === "inbox/spliced");
		expect(spliced).toHaveLength(3);

		const [s1, s2, s3] = spliced;
		if (
			s1.type !== "inbox/spliced" ||
			s2.type !== "inbox/spliced" ||
			s3.type !== "inbox/spliced"
		) {
			throw new Error("unreachable: filtered above");
		}
		expect(s1.queue).toBe("next-turn");
		expect(s1.messages.map((m) => m.content)).toEqual(["a"]);
		expect(s2.queue).toBe("next-turn");
		expect(s2.messages.map((m) => m.content)).toEqual(["a", "b"]);
		expect(s3.queue).toBe("next-step");
		expect(s3.messages.map((m) => m.content)).toEqual(["c"]);
		for (const e of [s1, s2, s3]) {
			expect(e.agentId).toBe("main");
			expect(typeof e.id).toBe("string");
			expect(typeof e.ts).toBe("string");
		}
	});

	it("drain/poll 清空内存队列但不追加 spliced 事件", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("a");
		await inbox.followup("b");
		await inbox.steer("c");
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(3);

		await inbox.drainNextTurn();
		await inbox.pollNextStep();
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(3);
	});

	it("foldInbox 从事件流转换出两队列最终状态（模拟 kill 后恢复）", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");

		await inbox.followup("a");
		await inbox.followup("b");
		await inbox.steer("c");
		// 模拟 kill：不落新事件，直接从文件重新转换
		const folded = foldInbox(await loadEvents(session.filePath));
		expect(folded.nextTurn.map((m) => m.content)).toEqual(["a", "b"]);
		expect(folded.nextStep.map((m) => m.content)).toEqual(["c"]);
	});

	it("foldInbox 忽略非 inbox 事件", async () => {
		const events: SessionEvent[] = [
			{
				type: "meta",
				sessionId: "s",
				createdAt: "2026-10-16T00:00:00.000Z",
				cwd: "/tmp",
				formatVersion: 1,
			},
			{
				type: "user_msg",
				id: "u1",
				ts: "2026-10-16T00:00:00.000Z",
				agentId: "main",
				content: "hi",
			},
			{
				type: "inbox/spliced",
				id: "i1",
				ts: "2026-10-16T00:00:01.000Z",
				agentId: "main",
				queue: "next-turn",
				messages: [{ id: "m1", content: "x" }],
			},
		];
		const folded = foldInbox(events);
		expect(folded.nextTurn).toEqual([{ id: "m1", content: "x" }]);
		expect(folded.nextStep).toEqual([]);
	});

	it("消息 id 去重：同 id 消息重复 splice 不重复入队", async () => {
		const ts = "2026-10-16T00:00:00.000Z";
		const mk = (queue: "next-turn" | "next-step"): SessionEvent => ({
			type: "inbox/spliced",
			id: `ev-${queue}`,
			ts,
			agentId: "main",
			queue,
			messages: [
				{ id: "m1", content: "first" },
				{ id: "m1", content: "first" },
				{ id: "m2", content: "second" },
			],
		});
		const folded = foldInbox([mk("next-turn"), mk("next-step")]);
		expect(folded.nextTurn).toEqual([
			{ id: "m1", content: "first" },
			{ id: "m2", content: "second" },
		]);
		expect(folded.nextStep).toEqual([
			{ id: "m1", content: "first" },
			{ id: "m2", content: "second" },
		]);
	});

	it("seed 播种恢复：两队列初始化为 foldInbox 形状，poll/drain 取播种内容且不追加 spliced", async () => {
		const session = await createSession("/tmp/proj", home);
		const seed = {
			nextTurn: [{ id: "f1", content: "followup-1" }],
			nextStep: [
				{ id: "s1", content: "steer-1" },
				{ id: "s2", content: "steer-2" },
			],
		};
		const inbox = createInbox(session, "main", { seed });

		// 播种内容可直接消费，顺序保持
		expect(await inbox.pollNextStep()).toEqual(["steer-1", "steer-2"]);
		expect(await inbox.pollNextStep()).toEqual([]);
		const nextTurn = await inbox.drainNextTurn();
		expect(nextTurn.map((m) => m.content)).toEqual(["followup-1"]);
		expect(await inbox.drainNextTurn()).toEqual([]);

		// 播种不追加 inbox/spliced（快照只由显式变更动词写入）
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(0);

		// 播种后照常走变更动词：入队并落盘该队列全量快照（只含新消息）
		await inbox.followup("新 followup");
		const spliced = (await loadEvents(session.filePath)).filter(
			(e) => e.type === "inbox/spliced",
		);
		expect(spliced).toHaveLength(1);
		const first = spliced[0];
		if (first.type !== "inbox/spliced") throw new Error("unreachable");
		expect(first.messages.map((m) => m.content)).toEqual(["新 followup"]);
	});

	it("cancel：每次调用触发一次 onCancel，不做队列变更、不落盘", async () => {
		const session = await createSession("/tmp/proj", home);
		const onCancel = vi.fn();
		const inbox = createInbox(session, "main", { onCancel });

		await inbox.followup("a");
		inbox.cancel();
		inbox.cancel();
		expect(onCancel).toHaveBeenCalledTimes(2);

		// 队列与落盘不受 cancel 影响
		expect(await inbox.drainNextTurn()).toHaveLength(1);
		expect(
			(await loadEvents(session.filePath)).filter(
				(e) => e.type === "inbox/spliced",
			),
		).toHaveLength(1);
	});

	it("cancel 未提供 onCancel 时不抛错", async () => {
		const session = await createSession("/tmp/proj", home);
		const inbox = createInbox(session, "main");
		expect(() => inbox.cancel()).not.toThrow();
	});
});
