// benchmark 遥测测试：断言 run 级批量、可比较字段、失败分类透传，
// 以及 payload 不含 prompt/patch 等任何内容字段。
// fetch 注入，不触网；安装 ID 写到临时 HOTPOT_HOME，避免污染本机用户态。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstanceResult } from "../src/report.ts";
import { reportBenchmarkRun } from "../src/telemetry.ts";

let home: string;
let oldHome: string | undefined;
let bodies: Array<{
	kind: string;
	installId: string;
	events: Array<Record<string, unknown>>;
}>;
let respondOk: boolean;

const SETTINGS: Settings = {
	models: {
		high: { provider: "test", model: "test", apiKey: "k" },
		medium: { provider: "test", model: "test", apiKey: "k" },
		low: { provider: "test", model: "test", apiKey: "k" },
	},
	telemetry: { enabled: true, endpoint: "http://telemetry.test" },
};

const META = {
	runId: "bench-20261111-143012-a1b2c3d4",
	benchmark: "swebench",
	dataset: "princeton-nlp/SWE-bench_Lite",
	split: "test",
	commit: "d7f3497abcdef0123456789abcdef0123456789a",
	commitDirty: false,
	model: "deepseek/deepseek-flash",
	tier: "high" as const,
	patchOnly: true,
	tasksetHash: "a".repeat(64),
};

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-bench-telemetry-"));
	oldHome = process.env.HOTPOT_HOME;
	process.env.HOTPOT_HOME = home;
	bodies = [];
	respondOk = true;
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
	bodies.push(JSON.parse(init.body ?? "{}"));
	return {
		ok: respondOk,
		status: respondOk ? 200 : 401,
		headers: new Headers(),
		body: null,
	};
}) as unknown as typeof fetch;

function instance(index: number): InstanceResult {
	return {
		instanceId: `django__django-${11000 + index}`,
		passed: index % 2 === 0,
		durationMs: 1000 + index,
		inputTokens: 100 + index,
		outputTokens: 10 + index,
		...(index % 2 === 0 ? {} : { failureClass: "agent_aborted" as const }),
	};
}

describe("reportBenchmarkRun", () => {
	it("一轮跑批按 200 条一批上报，不是每题一次请求", async () => {
		const delivery = await reportBenchmarkRun(
			SETTINGS,
			META,
			Array.from({ length: 300 }, (_, index) => instance(index)),
			{ fetchImpl },
		);

		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.events).toHaveLength(200);
		expect(bodies[1]?.events).toHaveLength(100);
		expect(delivery).toMatchObject({
			enabled: true,
			events: 300,
			sent: 300,
			failed: 0,
			batches: 2,
		});
	});

	it("每条事件都携带 runId 与本轮可比条件，且不含内容字段", async () => {
		await reportBenchmarkRun(SETTINGS, META, [instance(0), instance(1)], {
			fetchImpl,
		});

		const envelope = bodies[0];
		expect(envelope?.kind).toBe("benchmark");
		expect(envelope?.installId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		const events = envelope?.events ?? [];
		expect(events).toHaveLength(2);

		for (const event of events) {
			expect(event).toMatchObject({
				type: "benchmark_run",
				runId: META.runId,
				benchmark: "swebench",
				dataset: "princeton-nlp/SWE-bench_Lite",
				split: "test",
				commit: META.commit,
				commitDirty: false,
				model: "deepseek/deepseek-flash",
				tier: "high",
				patchOnly: true,
				tasksetHash: META.tasksetHash,
			});
		}
		expect(events[1]?.errorClass).toBe("agent_aborted");
		expect(events[0]?.errorClass).toBeUndefined();

		const serialized = JSON.stringify(bodies);
		for (const forbidden of [
			"prompt",
			"model_patch",
			"problem_statement",
			"apiKey",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("byTier 只发非零档位", async () => {
		await reportBenchmarkRun(
			SETTINGS,
			META,
			[
				{
					...instance(0),
					tokensByTier: {
						high: { input: 100, output: 10 },
						medium: { input: 0, output: 0 },
						low: { input: 20, output: 2 },
					},
				},
			],
			{ fetchImpl },
		);

		expect(bodies[0]?.events[0]?.byTier).toEqual({
			high: { inputTokens: 100, outputTokens: 10 },
			low: { inputTokens: 20, outputTokens: 2 },
		});
	});

	it("遥测关闭时不发请求，返回 enabled=false", async () => {
		const delivery = await reportBenchmarkRun(
			{ ...SETTINGS, telemetry: { enabled: false } },
			{ ...META, benchmark: "custom", dataset: "custom", split: "offline" },
			[instance(0)],
			{ fetchImpl },
		);
		expect(bodies).toHaveLength(0);
		expect(delivery).toMatchObject({ enabled: false, events: 1, sent: 0 });
	});

	it("服务端拒绝时不抛错，把丢数如实返回", async () => {
		respondOk = false;
		const delivery = await reportBenchmarkRun(
			SETTINGS,
			META,
			[instance(0), instance(1)],
			{ fetchImpl },
		);
		expect(delivery).toMatchObject({ enabled: true, sent: 0, failed: 2 });
	});
});
