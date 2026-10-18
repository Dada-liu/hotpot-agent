// 遥测批量客户端测试：全程注入 fetch 与调度器，不触网、不等待真实退避时间。
import { describe, expect, it, vi } from "vitest";
import {
	createTelemetryClient,
	defaultSchedule,
	type TelemetryClientOptions,
	type TelemetrySchedule,
} from "../src/client.ts";
import type { TelemetryEvent } from "../src/events.ts";

interface CapturedBatch {
	schemaVersion: number;
	kind: string;
	appVersion: string;
	installId: string;
	events: { eventId: string }[];
}

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: CapturedBatch;
}

function createFetch(
	handler: (call: number, init: RequestInit | undefined) => Promise<Response>,
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const call = requests.length;
		requests.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as CapturedBatch,
		});
		return handler(call, init);
	};
	return { fetchImpl, requests };
}

function okFetch(): {
	fetchImpl: typeof fetch;
	requests: CapturedRequest[];
} {
	return createFetch(async () => new Response("{}", { status: 200 }));
}

function createSchedule(): TelemetrySchedule & { sleeps: number[] } {
	const sleeps: number[] = [];
	return {
		sleeps,
		interval: () => () => {},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
}

function event(eventId: string): TelemetryEvent {
	return {
		eventId,
		ts: "2026-01-01T00:00:00.000Z",
		type: "session_end",
		sessionId: "s1",
		durationMs: 1,
		turns: 0,
		errors: 0,
	};
}

function baseOptions(): TelemetryClientOptions {
	return {
		kind: "user",
		installId: "00000000-0000-4000-8000-000000000000",
		endpoint: "https://telemetry.example",
		appVersion: "9.9.9",
		token: "secret-token",
		fetchImpl: okFetch().fetchImpl,
		schedule: createSchedule(),
	};
}

describe("createTelemetryClient", () => {
	it("posts three enqueued events as one envelope", async () => {
		const { fetchImpl, requests } = okFetch();
		const client = createTelemetryClient({ ...baseOptions(), fetchImpl });

		client.enqueue(event("e1"));
		client.enqueue(event("e2"));
		client.enqueue(event("e3"));
		await client.flush();

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://telemetry.example/api/v1/ingest");
		expect(requests[0].headers.get("content-type")).toBe("application/json");
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer secret-token",
		);
		expect(requests[0].body).toEqual({
			schemaVersion: 1,
			kind: "user",
			appVersion: "9.9.9",
			installId: "00000000-0000-4000-8000-000000000000",
			events: [event("e1"), event("e2"), event("e3")],
		});
		expect(client.stats()).toMatchObject({
			queued: 0,
			sent: 3,
			failed: 0,
			dropped: 0,
		});
	});

	it("omits the authorization header when there is no token", async () => {
		const { fetchImpl, requests } = okFetch();
		const client = createTelemetryClient({
			...baseOptions(),
			token: "",
			fetchImpl,
		});

		client.enqueue(event("e1"));
		await client.flush();

		expect(requests[0].headers.has("authorization")).toBe(false);
	});

	it("retries a rejected fetch and keeps the batch after success", async () => {
		const schedule = createSchedule();
		const { fetchImpl } = createFetch(async (call) => {
			if (call === 0) {
				throw new Error("network down");
			}
			return new Response("{}", { status: 200 });
		});
		const client = createTelemetryClient({
			...baseOptions(),
			fetchImpl,
			schedule,
		});

		client.enqueue(event("e1"));
		await expect(client.flush()).resolves.toBeUndefined();

		expect(schedule.sleeps).toEqual([1000]);
		expect(client.stats()).toMatchObject({ queued: 0, sent: 1, failed: 0 });
	});

	it("makes no request when disabled or when the endpoint is empty", async () => {
		const { fetchImpl, requests } = createFetch(
			async () => new Response("{}", { status: 200 }),
		);

		const disabled = createTelemetryClient({
			...baseOptions(),
			enabled: false,
			fetchImpl,
		});
		disabled.enqueue(event("e1"));
		await disabled.flush();
		await disabled.close();

		const noEndpoint = createTelemetryClient({
			...baseOptions(),
			endpoint: "",
			fetchImpl,
		});
		noEndpoint.enqueue(event("e2"));
		await noEndpoint.flush();
		await noEndpoint.close();

		expect(requests).toHaveLength(0);
	});

	it("drops the oldest event when the queue overflows", async () => {
		const { fetchImpl, requests } = okFetch();
		const client = createTelemetryClient({
			...baseOptions(),
			fetchImpl,
			maxQueue: 3,
			maxBatch: 10,
		});

		for (const id of ["e1", "e2", "e3", "e4"]) {
			client.enqueue(event(id));
		}
		expect(client.stats()).toMatchObject({ queued: 3, dropped: 1 });

		await client.flush();

		expect(requests[0].body.events.map((item) => item.eventId)).toEqual([
			"e2",
			"e3",
			"e4",
		]);
	});

	it("aborts a hanging request by timeout without rejecting flush", async () => {
		const { fetchImpl, requests } = createFetch(
			(_call, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(init.signal?.reason);
					});
				}),
		);
		const schedule = createSchedule();
		const client = createTelemetryClient({
			...baseOptions(),
			fetchImpl,
			schedule,
			timeoutMs: 10,
		});

		client.enqueue(event("e1"));
		await expect(client.flush()).resolves.toBeUndefined();

		expect(requests).toHaveLength(4);
		expect(schedule.sleeps).toEqual([1000, 2000, 4000]);
		expect(client.stats()).toMatchObject({ queued: 1, failed: 1 });
	});

	it("flushes pending events on close and ignores later enqueues", async () => {
		let intervalCallback: (() => void) | undefined;
		let cleared = false;
		const schedule: TelemetrySchedule = {
			interval: (callback) => {
				intervalCallback = callback;
				return () => {
					cleared = true;
				};
			},
			sleep: async () => {},
		};
		const { fetchImpl, requests } = okFetch();
		const client = createTelemetryClient({
			...baseOptions(),
			fetchImpl,
			schedule,
			flushIntervalMs: 1000,
		});

		client.enqueue(event("e1"));
		intervalCallback?.();
		await client.flush();
		expect(requests).toHaveLength(1);

		client.enqueue(event("e2"));
		await client.close();
		expect(requests).toHaveLength(2);
		expect(cleared).toBe(true);

		client.enqueue(event("e3"));
		await client.flush();
		expect(requests).toHaveLength(2);
	});
});

describe("defaultSchedule", () => {
	it("unrefs the interval handle and clears it on stop", () => {
		const timer = { unref: vi.fn() };
		const setIntervalMock = vi.fn(() => timer);
		const clearIntervalMock = vi.fn();
		vi.stubGlobal("setInterval", setIntervalMock);
		vi.stubGlobal("clearInterval", clearIntervalMock);
		try {
			const stop = defaultSchedule.interval(() => {}, 1000);

			expect(setIntervalMock).toHaveBeenCalledTimes(1);
			// 定时 flush 不能单独把 CLI 进程留在前台
			expect(timer.unref).toHaveBeenCalledTimes(1);

			stop();
			expect(clearIntervalMock).toHaveBeenCalledWith(timer);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("unrefs the retry sleep timeout", async () => {
		const timer = { unref: vi.fn() };
		vi.stubGlobal(
			"setTimeout",
			vi.fn((callback: () => void) => {
				callback();
				return timer;
			}),
		);
		try {
			await defaultSchedule.sleep(1000);

			// 重试退避等待同样不能阻止进程退出
			expect(timer.unref).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
