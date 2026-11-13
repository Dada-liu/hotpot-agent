// 遥测只读客户端测试：全部用注入的 fetch，不触网、不依赖真实 admin 密码。

import { describe, expect, it } from "vitest";
import {
	defaultQueryWindow,
	TelemetryReadClient,
	TelemetryReadError,
} from "../src/telemetry-read.ts";

const ENDPOINT = "http://telemetry.test:8080";

interface Call {
	url: string;
	init?: RequestInit;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function remoteRun(runId: string, overrides: Record<string, unknown> = {}) {
	return {
		runId,
		benchmark: "swebench",
		dataset: "SWE-bench/SWE-bench_Lite",
		split: "test",
		commit: "abc123",
		model: "kimi-k2",
		tier: "high",
		tasksetHash: null,
		firstSeen: "2026-11-13T01:00:00.000Z",
		lastSeen: "2026-11-13T02:00:00.000Z",
		instances: 10,
		attempts: 30,
		passed: 15,
		passRate: 50,
		resolvedInstances: 6,
		flakyInstances: 2,
		inputTokens: 3000,
		outputTokens: 300,
		avgDurationMs: 1000,
		tokensPerResolved: 220,
		...overrides,
	};
}

function fakeFetch(
	calls: Call[],
	handler: (url: string, init?: RequestInit) => Response,
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		return handler(url, init);
	}) as typeof fetch;
}

describe("TelemetryReadClient", () => {
	it("未设置 admin 密码时给出可执行的提示，且不发请求", async () => {
		const calls: Call[] = [];
		await expect(
			TelemetryReadClient.login({
				endpoint: ENDPOINT,
				env: {},
				fetchImpl: fakeFetch(calls, () => jsonResponse({})),
			}),
		).rejects.toMatchObject({
			kind: "credentials",
			message: expect.stringContaining("HOTPOT_TELEMETRY_ADMIN_PASSWORD"),
		});
		expect(calls).toHaveLength(0);
	});

	it("登录换 cookie，查询带 kind/from/to 与 Cookie", async () => {
		const calls: Call[] = [];
		const client = await TelemetryReadClient.login({
			endpoint: `${ENDPOINT}/`,
			password: "secret",
			env: {},
			fetchImpl: fakeFetch(calls, (url) => {
				if (url.includes("/login")) {
					return jsonResponse(
						{ ok: true },
						{
							headers: {
								"set-cookie": "hp_admin=signed-cookie; Path=/; HttpOnly",
							},
						},
					);
				}
				return jsonResponse({ data: [remoteRun("run-a")] });
			}),
		});
		expect(client.endpoint).toBe(ENDPOINT);
		const window = {
			from: "2026-11-10T00:00:00.000Z",
			to: "2026-11-14T00:00:00.000Z",
		};
		const runs = await client.benchmarkRuns(window);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.attempts).toBe(30);

		const login = calls[0];
		expect(login?.url).toBe(`${ENDPOINT}/api/v1/login`);
		expect(login?.init?.body).toContain("secret");
		const query = calls[1];
		expect(query?.url).toContain("kind=benchmark");
		expect(query?.url).toContain(encodeURIComponent(window.from));
		expect(query?.url).toContain(encodeURIComponent(window.to));
		expect((query?.init?.headers as Record<string, string>)?.cookie).toBe(
			"hp_admin=signed-cookie",
		);
	});

	it("401 与 429 分到可诊断的错误类别", async () => {
		await expect(
			TelemetryReadClient.login({
				endpoint: ENDPOINT,
				password: "wrong",
				env: {},
				fetchImpl: fakeFetch([], () => jsonResponse({}, { status: 401 })),
			}),
		).rejects.toMatchObject({ kind: "unauthorized" });
		await expect(
			TelemetryReadClient.login({
				endpoint: ENDPOINT,
				password: "wrong",
				env: {},
				fetchImpl: fakeFetch([], () => jsonResponse({}, { status: 429 })),
			}),
		).rejects.toMatchObject({ kind: "rate_limited" });
	});

	it("旧服务端返回缺字段时拒绝使用，不静默算出半套结论", async () => {
		const client = await TelemetryReadClient.login({
			endpoint: ENDPOINT,
			password: "secret",
			env: {},
			fetchImpl: fakeFetch([], (url) =>
				url.includes("/login")
					? jsonResponse(
							{},
							{ headers: { "set-cookie": "hp_admin=c; Path=/" } },
						)
					: jsonResponse({ data: [{ runId: "old", total: 9 }] }),
			),
		});
		await expect(
			client.benchmarkRuns({
				from: "2026-11-10T00:00:00.000Z",
				to: "2026-11-14T00:00:00.000Z",
			}),
		).rejects.toBeInstanceOf(TelemetryReadError);
		await expect(
			client.benchmarkRuns({
				from: "2026-11-10T00:00:00.000Z",
				to: "2026-11-14T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ kind: "invalid_response" });
	});

	it("逐题明细按 runId 做 URL 编码并保留 truncated", async () => {
		const calls: Call[] = [];
		const client = await TelemetryReadClient.login({
			endpoint: ENDPOINT,
			password: "secret",
			env: {},
			fetchImpl: fakeFetch(calls, (url) =>
				url.includes("/login")
					? jsonResponse(
							{},
							{ headers: { "set-cookie": "hp_admin=c; Path=/" } },
						)
					: jsonResponse({
							data: {
								runId: "run/a",
								instances: [
									{
										instanceId: "django__django-1",
										attempts: 3,
										passed: 1,
										passRate: 33.33,
										flaky: true,
										details: [],
									},
								],
								truncated: false,
							},
						}),
			),
		});
		const detail = await client.benchmarkRunDetail("run/a", {
			from: "2026-11-10T00:00:00.000Z",
			to: "2026-11-14T00:00:00.000Z",
		});
		expect(detail.instances[0]?.flaky).toBe(true);
		expect(calls[1]?.url).toContain("/benchmarks/run%2Fa/instances");
	});

	it("默认查询窗口覆盖登记时间前后", () => {
		const window = defaultQueryWindow(
			["2026-11-13T02:00:00.000Z", "2026-11-13T03:00:00.000Z"],
			new Date("2026-11-13T04:00:00.000Z"),
		);
		expect(Date.parse(window.from)).toBeLessThan(
			Date.parse("2026-11-13T02:00:00.000Z"),
		);
		expect(Date.parse(window.to)).toBeGreaterThan(
			Date.parse("2026-11-13T04:00:00.000Z"),
		);
	});
});
