// 异步批量上报客户端：内存排队、阈值/定时 flush、批量 POST、指数退避重试。
// 设计原则是永不阻塞、永不抛错：enqueue 同步返回；flush 串行执行且吞掉所有失败。
// 最终失败的一批放回队首，等下一次 flush 再试，避免一次网络抖动丢数据。
// close 是例外：它只做一次有界尝试（不重试、不退避），保证 CLI /exit 不被网络拖住。

import { APP_VERSION, DEFAULT_TELEMETRY_ENDPOINT } from "./defaults.ts";
import {
	SCHEMA_VERSION,
	type TelemetryEvent,
	type TelemetryKind,
} from "./events.ts";

const INGEST_PATH = "/api/v1/ingest";
const DEFAULT_FLUSH_INTERVAL_MS = 30000;
const DEFAULT_MAX_BATCH = 50;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
// 重试 3 次的退避间隔：第 1/2/3 次重试前分别等待 1s/2s/4s
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

// 定时器注入：默认使用全局 setInterval/setTimeout，测试可替换为立即返回的实现
export interface TelemetrySchedule {
	interval(callback: () => void, intervalMs: number): () => void;
	sleep(ms: number): Promise<void>;
}

export interface TelemetryClientOptions {
	kind: TelemetryKind;
	installId: string;
	endpoint?: string;
	appVersion?: string;
	token?: string;
	enabled?: boolean;
	flushIntervalMs?: number;
	maxBatch?: number;
	maxQueue?: number;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
	schedule?: TelemetrySchedule;
}

export interface TelemetryStats {
	queued: number;
	sent: number;
	failed: number;
	dropped: number;
	lastFlushAt: number | null;
}

export interface TelemetryClient {
	enqueue(event: TelemetryEvent): void;
	flush(): Promise<void>;
	close(): Promise<void>;
	stats(): TelemetryStats;
}

export function createTelemetryClient(
	opts: TelemetryClientOptions,
): TelemetryClient {
	const schedule = opts.schedule ?? defaultSchedule;
	const now = opts.now ?? Date.now;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const endpoint = (opts.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT)
		.trim()
		.replace(/\/+$/, "");
	const active = (opts.enabled ?? true) && endpoint !== "";
	// 0 或负数 = 不定时 flush（只靠阈值与 close 触发）；undefined/非有限数回落到默认 30s
	const flushIntervalMs =
		opts.flushIntervalMs === undefined || !Number.isFinite(opts.flushIntervalMs)
			? DEFAULT_FLUSH_INTERVAL_MS
			: Math.max(0, Math.floor(opts.flushIntervalMs));
	const maxBatch = positiveInt(opts.maxBatch, DEFAULT_MAX_BATCH);
	const maxQueue = nonNegativeInt(opts.maxQueue, DEFAULT_MAX_QUEUE);
	const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
	const appVersion = opts.appVersion ?? APP_VERSION;
	const url = `${endpoint}${INGEST_PATH}`;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (opts.token !== undefined && opts.token !== "") {
		headers.authorization = `Bearer ${opts.token}`;
	}

	const queue: TelemetryEvent[] = [];
	let closed = false;
	// 收尾标志：close 之后在途 flush 不再重试/退避，避免退出前再等 1/2/4 秒
	let closing = false;
	let flushing: Promise<void> = Promise.resolve();
	let sent = 0;
	let failed = 0;
	let dropped = 0;
	let lastFlushAt: number | null = null;

	// 把一批事件编码后 POST 出去；网络错误和超时都只返回 false，交给重试循环。
	// holdProcess 为 true（close 的收尾请求）时改用 ref 的定时器代替 AbortSignal.timeout：
	// 此时若事件循环里只剩 unref 句柄，进程会在请求结算前退出（Node 以 code 13 结束），
	// 最后一批数据随之丢失。定时器在请求结算后立即清除，不会额外拖延退出。
	async function postBatch(
		body: string,
		holdProcess: boolean,
	): Promise<boolean> {
		try {
			if (!holdProcess) {
				const response = await fetchImpl(url, {
					method: "POST",
					headers,
					body,
					signal: AbortSignal.timeout(timeoutMs),
				});
				// 显式释放响应体，避免长连接因未消费而滞留
				await response.body?.cancel().catch(() => {});
				return response.ok;
			}
			const controller = new AbortController();
			const timer = setTimeout(() => {
				controller.abort();
			}, timeoutMs);
			try {
				const response = await fetchImpl(url, {
					method: "POST",
					headers,
					body,
					signal: controller.signal,
				});
				await response.body?.cancel().catch(() => {});
				return response.ok;
			} finally {
				clearTimeout(timer);
			}
		} catch {
			return false;
		}
	}

	// final 为 true 时只尝试一次：不重试、不 sleep，供 close 使用
	async function flushBatch(final: boolean): Promise<void> {
		if (!active || queue.length === 0) {
			return;
		}
		const batch = queue.splice(0, maxBatch);

		try {
			const body = JSON.stringify({
				schemaVersion: SCHEMA_VERSION,
				kind: opts.kind,
				appVersion,
				installId: opts.installId,
				events: batch,
			});

			for (let attempt = 0; ; attempt += 1) {
				// 收尾已开始：不再发起新的重试，剩余事件留给最后一次收尾请求
				if (attempt > 0 && closing) {
					break;
				}
				if (await postBatch(body, final)) {
					sent += batch.length;
					lastFlushAt = now();
					return;
				}
				const delay = RETRY_DELAYS_MS[attempt];
				if (final || delay === undefined) {
					break;
				}
				await schedule.sleep(delay);
			}
			// 失败或收尾中止：整批放回队首，保证顺序不变
			queue.unshift(...batch);
			failed += batch.length;
			lastFlushAt = now();
		} catch {
			// 兜底：任何意外都不能丢数据，也不能让 flush 抛错
			queue.unshift(...batch);
			failed += batch.length;
		}
	}

	function flush(): Promise<void> {
		// 串行化：并发调用按注册顺序排队，避免同一批事件被重复发送
		flushing = flushing.then(() => flushBatch(false));
		return flushing;
	}

	function enqueue(event: TelemetryEvent): void {
		if (!active || closed) {
			return;
		}
		queue.push(event);
		if (queue.length > maxQueue) {
			const overflow = queue.length - maxQueue;
			queue.splice(0, overflow);
			dropped += overflow;
		}
		if (queue.length >= maxBatch) {
			// 达到阈值立即异步发送，不阻塞调用方
			void flush();
		}
	}

	function stats(): TelemetryStats {
		return {
			queued: queue.length,
			sent,
			failed,
			dropped,
			lastFlushAt,
		};
	}

	let stopTimer: () => void = () => {};
	if (active && flushIntervalMs > 0) {
		stopTimer = schedule.interval(() => {
			void flush();
		}, flushIntervalMs);
	}

	async function close(): Promise<void> {
		if (closed) {
			return;
		}
		closed = true;
		closing = true;
		stopTimer();
		// 收尾只做一次有界尝试：不重试、不退避，也不等待在途 flush 的重试链。
		// 否则 /exit 后用户可能多等 1/2/4 秒的 sleep 加整条重试链（约 27 秒）。
		await flushBatch(true);
	}

	return { enqueue, flush, close, stats };
}

interface UnrefableTimer {
	unref?: () => void;
}

// 默认定时器必须 unref：CLI 漏调 close() 时，定时 flush 和重试退避都不能阻止进程退出
function unrefTimer(handle: unknown): void {
	(handle as UnrefableTimer | undefined)?.unref?.();
}

export const defaultSchedule: TelemetrySchedule = {
	interval(callback, intervalMs) {
		const handle = setInterval(callback, intervalMs);
		unrefTimer(handle);
		return () => {
			clearInterval(handle);
		};
	},
	sleep(ms) {
		return new Promise((resolve) => {
			const handle = setTimeout(resolve, ms);
			unrefTimer(handle);
		});
	},
};

function positiveInt(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.floor(value);
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) {
		return fallback;
	}
	return Math.floor(value);
}
