// JSONL 会话日志 tailer：start 先补读历史（fromOffset，默认 0）整批回调，再进入跟随模式。
// 跟随由 fs.watch 触发增量读，pollIntervalMs（默认 250）轮询文件大小兜底；
// 只读新增字节，按行 JSON.parse（坏行/空行跳过），末尾无换行的半行留待下次拼接。
// offset() 暴露已消费字节数（完整行才推进，半行不算），供断线重连携带续读。
// watch 报错（文件被删等）不抛给调用方，降级为纯轮询。

import { watch } from "node:fs";
import { open } from "node:fs/promises";
import type { SessionEvent } from "@hotpot/core";

export type TailerOptions = {
	// 每解析出一批事件回调一次；初始补读为单批
	onEvents: (events: SessionEvent[]) => void;
	// 起始字节偏移，默认 0；断线重连时由客户端携带上次 offset 续读
	fromOffset?: number;
	// 轮询兜底间隔；watch 不可靠的平台/文件系统上保证最终一致
	pollIntervalMs?: number;
};

export type Tailer = {
	start(): Promise<void>;
	stop(): void;
	offset(): number;
};

const DEFAULT_POLL_INTERVAL_MS = 250;
const LF = 0x0a;

// 拼接两段字节；任一侧为空时避免拷贝
function concatBytes(
	a: Uint8Array<ArrayBufferLike>,
	b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

export function createTailer(filePath: string, opts: TailerOptions): Tailer {
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	let offset = 0; // 已消费字节数（完整行边界；半行不算，重连从此续读）
	let readPos = 0; // 已读入内存的字节位置，保证每个字节只读一次
	let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0); // 末尾未遇换行的残留字节（半行），下次拼接
	let handle: HotpotFileHandle | null = null;
	let watcher: HotpotFsWatcher | null = null;
	let pollTimer: number | null = null;
	let reading = false; // 增量读串行化：watch 与 poll 可能并发触发
	let firstStart = true; // 首次 start 用 fromOffset 定位，之后原地重启续读内部 offset

	// 把新增字节与残留拼接后切成完整行；末尾无换行的部分留作残留，不产生事件。
	// 只在换行字节处切分，UTF-8 多字节字符的续字节不会是 0x0a，故整段 decode 安全。
	function consume(chunk: Uint8Array<ArrayBufferLike>): SessionEvent[] {
		const merged = concatBytes(pending, chunk);
		let lastLf = -1;
		for (let i = merged.length - 1; i >= 0; i--) {
			if (merged[i] === LF) {
				lastLf = i;
				break;
			}
		}
		if (lastLf < 0) {
			pending = merged;
			return [];
		}
		pending = merged.subarray(lastLf + 1);
		const events: SessionEvent[] = [];
		const text = new TextDecoder().decode(merged.subarray(0, lastLf));
		for (const raw of text.split("\n")) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (line === "") continue; // 空行跳过
			try {
				events.push(JSON.parse(line) as SessionEvent);
			} catch {
				// 坏行跳过，不抛出（写入中途被 kill 等场景会留下残缺行）
			}
		}
		return events;
	}

	// 增量读：从 readPos 读到文件末尾，解析后回调；读失败不抛出，交给下一轮
	async function readMore(): Promise<void> {
		const h = handle;
		if (!h || reading) return;
		reading = true;
		try {
			const { size } = await h.stat();
			if (size <= readPos) return; // 无新增字节；文件被截断时同样跳过（骨架不处理截断重读）
			const buf = new Uint8Array(size - readPos);
			let filled = 0;
			while (filled < buf.length) {
				const { bytesRead } = await h.read(
					buf,
					filled,
					buf.length - filled,
					readPos + filled,
				);
				if (bytesRead === 0) break;
				filled += bytesRead;
			}
			readPos += filled;
			const events = consume(buf.subarray(0, filled));
			// 已消费 = 已读末尾 - 残留半行；半行字节不算消费
			offset = readPos - pending.length;
			if (events.length > 0) opts.onEvents(events);
		} catch {
			// 读失败（文件被删等）不抛给调用方；watch/poll 下一轮会重试
		} finally {
			reading = false;
		}
	}

	function dropWatcher(): void {
		try {
			watcher?.close();
		} catch {
			// 句柄已失效时关闭可能再抛，忽略
		}
		watcher = null;
	}

	async function start(): Promise<void> {
		if (handle) return; // 已启动，幂等
		const from = firstStart ? (opts.fromOffset ?? 0) : offset;
		firstStart = false;
		pending = new Uint8Array(0);
		offset = from;
		readPos = from;
		handle = await open(filePath, "r");
		await readMore(); // 初始补读：历史内容整批回调
		try {
			watcher = watch(filePath, () => {
				void readMore();
			});
			watcher.on("error", () => {
				// 降级为纯轮询
				dropWatcher();
			});
		} catch {
			dropWatcher(); // watch 同步失败同样降级
		}
		pollTimer = setInterval(() => {
			void readMore();
		}, pollIntervalMs);
	}

	function stop(): void {
		dropWatcher();
		if (pollTimer !== null) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		const h = handle;
		handle = null;
		if (h) void h.close(); // 关闭异步进行；offset 保留，原地重启可续读
	}

	function offsetNow(): number {
		return offset;
	}

	return { start, stop, offset: offsetNow };
}
