// benchmark 遥测：以「一轮跑批」为单位批量上报，每条 benchmark_run 都带同一份可比较条件。
// 两条硬约束决定了现在的形状：
// 1. 服务端 /ingest 是 60 req/min 的滑动窗口限流。旧实现每题一次 POST，300 题的跑批
//    在收尾阶段连发 300 次，实测 70 题就丢掉 8 条且完全静默。所以这里按 200 条一批，
//    300 题只发 2 次请求。
// 2. 没有 runId 的 N 条事件只是一堆散点，服务端只能算时间窗口内的混合通过率。
//    所以 runId 与 commit/model/tier/patchOnly/tasksetHash 一起下发，作为本地 manifest
//    的远端副本——「可比较」必须跟着数据一起走到远端，否则远端无从判断两轮能否对比。
//
// 遥测始终是旁路：关闭、endpoint 为空、网络失败都不抛错；但投递结果会返回给调用方，
// 由调用方写进 report.json —— 丢了多少条必须可查。

import { randomUUID } from "node:crypto";
import type { ModelTier, Settings } from "@hotpot/core";
import {
	APP_VERSION,
	type BenchmarkRunEvent,
	createTelemetryRuntime,
} from "@hotpot/telemetry";
import type { InstanceResult, TelemetryDelivery } from "./report.ts";
import type { TierTokens } from "./tokens.ts";

// 单批上限：服务端 MAX_BATCH_EVENTS=500、MAX_BATCH_BYTES=1MiB。
// 200 条 × 约 400B ≈ 80KB，留足余量，也给未来加字段留空间。
const BATCH_SIZE = 200;
// 排空队列的最大轮数；配合「无进展即停」，避免持续失败时卡住跑批收尾
const MAX_FLUSH_ROUNDS = 64;

// 一轮跑批的实验条件；字段名与服务端 benchmark_run 白名单一一对应。
// runId/model/tier/patchOnly 必填（schemaVersion 2）：缺了它们远端无法按轮聚合，
// 也无法判断两轮能否对比——那正是这次改造要解决的问题。
export interface BenchmarkRunMeta {
	runId: string;
	benchmark: string;
	dataset: string;
	split: string;
	model: string;
	tier: ModelTier;
	patchOnly: boolean;
	// commit 允许缺失：跑批目录可能不在 git 仓库里
	commit?: string;
	commitDirty?: boolean;
	tasksetHash?: string;
}

export interface ReportBenchmarkRunDeps {
	fetchImpl?: typeof fetch;
}

export async function reportBenchmarkRun(
	settings: Settings,
	meta: BenchmarkRunMeta,
	instances: InstanceResult[],
	deps: ReportBenchmarkRunDeps = {},
): Promise<TelemetryDelivery> {
	const events = instances.map((instance) => buildEvent(meta, instance));
	const skipped: TelemetryDelivery = {
		enabled: false,
		events: events.length,
		sent: 0,
		failed: 0,
		batches: 0,
		dropped: 0,
	};
	if (events.length === 0) {
		return skipped;
	}

	const runtime = createTelemetryRuntime(settings, {
		kind: "benchmark",
		appVersion: APP_VERSION,
		fetchImpl: deps.fetchImpl,
		maxBatch: BATCH_SIZE,
		maxQueue: events.length + BATCH_SIZE,
	});
	if (runtime === null) {
		return skipped;
	}

	for (const event of events) {
		runtime.client.enqueue(event);
	}

	// flush 一次只送一批，需要反复调用把队列排空；
	// 若某一轮送完之后队列长度没有变化（说明这一批重试三次仍失败、被放回队首），
	// 立即停止——继续重试只会让跑批收尾多等若干个 7 秒。
	let previousQueued = -1;
	for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
		const queued = runtime.client.stats().queued;
		if (queued === 0 || queued === previousQueued) {
			break;
		}
		previousQueued = queued;
		await runtime.client.flush();
	}
	await runtime.client.close();

	const stats = runtime.client.stats();
	return {
		enabled: true,
		events: events.length,
		sent: stats.sent,
		failed: Math.max(0, events.length - stats.sent),
		batches: Math.ceil(events.length / BATCH_SIZE),
		dropped: stats.dropped,
	};
}

function buildEvent(
	meta: BenchmarkRunMeta,
	instance: InstanceResult,
): BenchmarkRunEvent {
	return {
		eventId: randomUUID(),
		ts: new Date().toISOString(),
		type: "benchmark_run",
		benchmark: meta.benchmark,
		dataset: meta.dataset,
		split: meta.split,
		instanceId: instance.instanceId,
		// 同一题的第几次尝试；单次跑批（custom）没有 attempt 字段，按 1 上报。
		// 服务端以 (runId, instanceId, attempt) 为主键，缺了它就无法区分重复尝试。
		attempt: instance.attempt ?? 1,
		passed: instance.passed,
		durationMs: instance.durationMs,
		inputTokens: instance.inputTokens,
		outputTokens: instance.outputTokens,
		runId: meta.runId,
		model: meta.model,
		tier: meta.tier,
		patchOnly: meta.patchOnly,
		...(meta.commit === undefined ? {} : { commit: meta.commit }),
		...(meta.commitDirty === undefined
			? {}
			: { commitDirty: meta.commitDirty }),
		...(meta.tasksetHash === undefined
			? {}
			: { tasksetHash: meta.tasksetHash }),
		...(instance.failureClass === undefined
			? {}
			: { errorClass: instance.failureClass }),
		...(instance.tokensByTier === undefined
			? {}
			: { byTier: compactTier(instance.tokensByTier) }),
	};
}

// 只发非零档位：全零档位对成本归因没有信息量，白占字节
function compactTier(
	tokens: TierTokens,
): Record<string, { inputTokens: number; outputTokens: number }> {
	const result: Record<string, { inputTokens: number; outputTokens: number }> =
		{};
	for (const tier of ["high", "medium", "low"] as const) {
		const usage = tokens[tier];
		if (usage.input === 0 && usage.output === 0) {
			continue;
		}
		result[tier] = { inputTokens: usage.input, outputTokens: usage.output };
	}
	return result;
}
