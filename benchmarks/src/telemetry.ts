// benchmark 遥测：一次跑批的每题一条 benchmark_run，kind 固定 "benchmark"，
// 使用独立的 benchmark install ID（<home>/telemetry/benchmark-install-id），
// 不复用真实用户设备标识。字段严格限定为数据集/题号/通过与否/时长/token。
// 遥测是旁路：关闭、endpoint 为空、网络失败都不抛错，也不影响报告。
// 调用方在每个 instance 结束后调用一次，避免长跑批把事件堆在内存里。

import { randomUUID } from "node:crypto";
import type { Settings } from "@hotpot/core";
import {
	APP_VERSION,
	type BenchmarkRunEvent,
	createTelemetryRuntime,
} from "@hotpot/telemetry";
import type { InstanceResult } from "./report.ts";

export interface BenchmarkRunResult extends InstanceResult {
	benchmark?: string;
	dataset: string;
	split: string;
}

export interface ReportBenchmarkRunDeps {
	fetchImpl?: typeof fetch;
}

export async function reportBenchmarkRun(
	settings: Settings,
	result: BenchmarkRunResult,
	deps: ReportBenchmarkRunDeps = {},
): Promise<void> {
	const runtime = createTelemetryRuntime(settings, {
		kind: "benchmark",
		appVersion: APP_VERSION,
		fetchImpl: deps.fetchImpl,
	});
	if (runtime === null) {
		return;
	}

	const event: BenchmarkRunEvent = {
		eventId: randomUUID(),
		ts: new Date().toISOString(),
		type: "benchmark_run",
		benchmark: result.benchmark ?? "hotpot-agent",
		dataset: result.dataset,
		split: result.split,
		instanceId: result.instanceId,
		passed: result.passed,
		durationMs: result.durationMs,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
	};
	runtime.client.enqueue(event);
	await runtime.client.flush();
	await runtime.client.close();
}
