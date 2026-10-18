// runtime endpoint 解析测试：settings 里的空值必须优雅回退，绝不能抛错。
// 全程注入 fetch 与临时 home，不触网、不污染真实安装 ID。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelemetryEvent } from "../src/events.ts";
import { createTelemetryRuntime } from "../src/runtime.ts";

const SETTINGS: Settings = {
	models: {
		high: { provider: "test", model: "high", apiKey: "k" },
		medium: { provider: "test", model: "medium", apiKey: "k" },
		low: { provider: "test", model: "low", apiKey: "k" },
	},
};

const EVENT: TelemetryEvent = {
	eventId: "e1",
	ts: "2026-01-01T00:00:00.000Z",
	type: "session_end",
	sessionId: "s1",
	durationMs: 1,
	turns: 0,
	errors: 0,
};

let home: string;
let oldEndpoint: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-telemetry-runtime-"));
	oldEndpoint = process.env.HOTPOT_TELEMETRY_ENDPOINT;
	delete process.env.HOTPOT_TELEMETRY_ENDPOINT;
});

afterEach(async () => {
	if (oldEndpoint === undefined) {
		delete process.env.HOTPOT_TELEMETRY_ENDPOINT;
	} else {
		process.env.HOTPOT_TELEMETRY_ENDPOINT = oldEndpoint;
	}
	await rm(home, { recursive: true, force: true });
});

// 入队一条事件后 close，返回实际上报的 URL；runtime 为 null 时返回 null
async function reportedUrls(settings: Settings): Promise<string[] | null> {
	const urls: string[] = [];
	const runtime = createTelemetryRuntime(settings, {
		home,
		appVersion: "0.0.0",
		fetchImpl: async (input) => {
			urls.push(String(input));
			return new Response("{}", { status: 200 });
		},
	});
	if (runtime === null) {
		return null;
	}
	runtime.client.enqueue(EVENT);
	await runtime.client.close();
	return urls;
}

describe("createTelemetryRuntime endpoint", () => {
	it("settings endpoint 优先于环境变量", async () => {
		process.env.HOTPOT_TELEMETRY_ENDPOINT = "https://env.example";
		const urls = await reportedUrls({
			...SETTINGS,
			telemetry: { endpoint: "https://settings.example" },
		});

		expect(urls).toEqual(["https://settings.example/api/v1/ingest"]);
	});

	it("settings endpoint 为空串时回退到环境变量", async () => {
		process.env.HOTPOT_TELEMETRY_ENDPOINT = "https://env.example";
		const urls = await reportedUrls({
			...SETTINGS,
			telemetry: { endpoint: "" },
		});

		expect(urls).toEqual(["https://env.example/api/v1/ingest"]);
	});

	it("settings endpoint 为纯空白时回退到环境变量", async () => {
		process.env.HOTPOT_TELEMETRY_ENDPOINT = "https://env.example";
		const urls = await reportedUrls({
			...SETTINGS,
			telemetry: { endpoint: "   " },
		});

		expect(urls).toEqual(["https://env.example/api/v1/ingest"]);
	});

	it("空的环境变量遮挡源码常量：settings 为空时 runtime 为 null", () => {
		// ?? 只跳过 undefined；空串环境变量是显式关闭，不再回退到源码常量
		process.env.HOTPOT_TELEMETRY_ENDPOINT = "";
		const runtime = createTelemetryRuntime(
			{ ...SETTINGS, telemetry: { endpoint: "" } },
			{ home, appVersion: "0.0.0" },
		);

		expect(runtime).toBeNull();
	});

	it("settings 与环境变量都未设置时（源码常量为空）runtime 为 null", () => {
		const runtime = createTelemetryRuntime(SETTINGS, {
			home,
			appVersion: "0.0.0",
		});

		expect(runtime).toBeNull();
	});

	it("settings endpoint 非法协议时 runtime 为 null", () => {
		const runtime = createTelemetryRuntime(
			{ ...SETTINGS, telemetry: { endpoint: "ftp://telemetry.example" } },
			{ home, appVersion: "0.0.0" },
		);

		expect(runtime).toBeNull();
	});
});
