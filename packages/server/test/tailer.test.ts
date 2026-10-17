// tailer 测试：初始补读（坏行/空行跳过、整批回调）、stop 后不再回调、
// 携带上次 offset 重启只收增量（新 tailer 与原地重启两种姿势）、半行缓冲待拼接。

import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTailer, type Tailer } from "../src/tailer.ts";

let dir: string;
let logFile: string;

// 测试用最小合法事件：user_msg 的必填字段即可
function ev(n: number): SessionEvent {
	return {
		type: "user_msg",
		id: `id-${n}`,
		ts: "2026-10-17T00:00:00.000Z",
		agentId: "main",
		content: `msg-${n}`,
	};
}

function line(e: SessionEvent): string {
	return `${JSON.stringify(e)}\n`;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "hotpot-tail-"));
	logFile = join(dir, "session.jsonl");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

// 轮询等待条件成立（fake timers 会干扰 fs.watch/poll 的协同，实测用小轮询间隔更稳）
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// 收集回调事件的辅助 tailer；fromOffset 用于模拟断线重连的续读
function collecting(fromOffset?: number) {
	const batches: SessionEvent[][] = [];
	const tailer: Tailer = createTailer(logFile, {
		onEvents: (events) => batches.push(events),
		pollIntervalMs: 20,
		fromOffset,
	});
	const all = () => batches.flat();
	return { batches, tailer, all };
}

describe("createTailer", () => {
	it("初始补读：3 个合法事件 + 1 条坏行 + 空行 → 整批回调 3 个事件，坏行与空行跳过", async () => {
		await writeFile(
			logFile,
			`${line(ev(1))}${line(ev(2))}not-json{{{b\n\n${line(ev(3))}`,
		);
		const { batches, tailer, all } = collecting();

		await tailer.start();
		await waitFor(() => all().length === 3);

		expect(batches.length).toBe(1);
		expect(all().map((e) => (e as { content: string }).content)).toEqual([
			"msg-1",
			"msg-2",
			"msg-3",
		]);
		expect(tailer.offset()).toBeGreaterThan(0);
		tailer.stop();
	});

	it("stop 后 append 不再回调", async () => {
		await writeFile(logFile, line(ev(1)));
		const { tailer, all } = collecting();

		await tailer.start();
		await waitFor(() => all().length === 1);
		tailer.stop();

		await appendFile(logFile, line(ev(2)));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(all().length).toBe(1);
		expect(tailer.offset()).toBe(line(ev(1)).length);
	});

	it("新 tailer 携带上次 offset：只收到增量事件", async () => {
		await writeFile(logFile, line(ev(1)));
		const first = collecting();
		await first.tailer.start();
		await waitFor(() => first.all().length === 1);
		first.tailer.stop();

		await appendFile(logFile, line(ev(2)));
		const second = collecting(first.tailer.offset());
		await second.tailer.start();
		await waitFor(() => second.all().length === 1);

		expect(second.all().map((e) => (e as { content: string }).content)).toEqual(
			["msg-2"],
		);
		second.tailer.stop();
	});

	it("原地 stop 后再 start（不带 fromOffset）：续读增量", async () => {
		await writeFile(logFile, line(ev(1)));
		const { tailer, all } = collecting();

		await tailer.start();
		await waitFor(() => all().length === 1);
		tailer.stop();

		await appendFile(logFile, line(ev(2)));
		await tailer.start();
		await waitFor(() => all().length === 2);

		expect(all().map((e) => (e as { content: string }).content)).toEqual([
			"msg-1",
			"msg-2",
		]);
		tailer.stop();
	});

	it("半行：append 半个 JSON 行无回调也不推进 offset，补全后收到完整事件", async () => {
		await writeFile(logFile, "");
		const { tailer, all } = collecting();

		await tailer.start();
		const full = line(ev(9));
		const halfAt = full.length - 10;
		await appendFile(logFile, full.slice(0, halfAt));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(all().length).toBe(0);
		expect(tailer.offset()).toBe(0);

		await appendFile(logFile, full.slice(halfAt));
		await waitFor(() => all().length === 1);
		expect(all().map((e) => (e as { content: string }).content)).toEqual([
			"msg-9",
		]);
		tailer.stop();
	});

	it("跟随模式：start 后 append 的新行经 watch/poll 增量回调", async () => {
		await writeFile(logFile, line(ev(1)));
		const { tailer, all } = collecting();

		await tailer.start();
		await waitFor(() => all().length === 1);

		await appendFile(logFile, line(ev(2)));
		await waitFor(() => all().length === 2);
		expect(all().map((e) => (e as { content: string }).content)).toEqual([
			"msg-1",
			"msg-2",
		]);
		tailer.stop();
	});
});
