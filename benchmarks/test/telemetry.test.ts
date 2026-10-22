// benchmark 遥测测试：断言 envelope 的 kind、benchmark_run 字段白名单，
// 以及 payload 不含 prompt/patch 等任何内容字段。fetch 注入，不触网。
// 安装 ID 写到临时 HOTPOT_HOME，避免污染本机用户态。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportBenchmarkRun } from "../src/telemetry.ts";

let home: string;
let oldHome: string | undefined;
let fetchCalls: number;
let body: unknown;

const SETTINGS: Settings = {
	models: {
		high: { provider: "test", model: "test", apiKey: "k" },
		medium: { provider: "test", model: "test", apiKey: "k" },
		low: { provider: "test", model: "test", apiKey: "k" },
	},
	telemetry: { enabled: true, endpoint: "http://telemetry.test" },
};

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-bench-telemetry-"));
	oldHome = process.env.HOTPOT_HOME;
	process.env.HOTPOT_HOME = home;
	fetchCalls = 0;
	body = undefined;
});

afterEach(async () => {
	if (oldHome === undefined) {
		delete process.env.HOTPOT_HOME;
	} else {
		process.env.HOTPOT_HOME = oldHome;
	}
	await rm(home, { recursive: true, force: true });
});

const fetchImpl = (async (_url: unknown, init: { body?: string }) => {
	fetchCalls += 1;
	body = JSON.parse(init.body ?? "{}") as unknown;
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		body: null,
	};
}) as unknown as typeof fetch;

describe("reportBenchmarkRun", () => {
	it("上报 kind=benchmark 的单条 benchmark_run，且不含内容字段", async () => {
		await reportBenchmarkRun(
			SETTINGS,
			{
				benchmark: "swebench",
				dataset: "princeton-nlp/SWE-bench_Lite",
				split: "test",
				instanceId: "django__django-11099",
				passed: true,
				durationMs: 1234,
				inputTokens: 100,
				outputTokens: 20,
			},
			{ fetchImpl },
		);

		expect(fetchCalls).toBe(1);
		const envelope = body as {
			kind: string;
			installId: string;
			events: Array<Record<string, unknown>>;
		};
		expect(envelope.kind).toBe("benchmark");
		expect(envelope.installId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(envelope.events).toHaveLength(1);
		const event = envelope.events[0] ?? {};
		expect(event).toMatchObject({
			type: "benchmark_run",
			benchmark: "swebench",
			dataset: "princeton-nlp/SWE-bench_Lite",
			split: "test",
			instanceId: "django__django-11099",
			passed: true,
			durationMs: 1234,
			inputTokens: 100,
			outputTokens: 20,
		});
		expect(Object.keys(event).sort()).toEqual([
			"benchmark",
			"dataset",
			"durationMs",
			"eventId",
			"inputTokens",
			"instanceId",
			"outputTokens",
			"passed",
			"split",
			"ts",
			"type",
		]);
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("prompt");
		expect(serialized).not.toContain("model_patch");
		expect(serialized).not.toContain("problem_statement");
	});

	it("遥测关闭时不发请求", async () => {
		await reportBenchmarkRun(
			{ ...SETTINGS, telemetry: { enabled: false } },
			{
				benchmark: "custom",
				dataset: "custom",
				split: "offline",
				instanceId: "finance-daily-returns",
				passed: false,
				durationMs: 10,
				inputTokens: 1,
				outputTokens: 1,
			},
			{ fetchImpl },
		);
		expect(fetchCalls).toBe(0);
	});
});
