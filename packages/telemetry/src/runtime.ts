// CLI/server 共用的遥测运行时装配：把 settings、安装 ID、批量客户端与 turn 采集器工厂打包。
// 同步 API 是刻意的：install ID 只读写一个小文件，client 构造不触网；返回 null 表示遥测关闭
// 或 endpoint 不可用，调用方把 null 当作「旁路未启用」，无需任何额外分支。
// 这里不抛错：配置再离谱也只退化为 null 或「不带 Authorization 上报」。

import type { Session, Settings } from "@hotpot/core";
import { createTelemetryClient, type TelemetryClient } from "./client.ts";
import {
	createTelemetryCollector,
	type TelemetryCollector,
} from "./collector.ts";
import { DEFAULT_TELEMETRY_ENDPOINT } from "./defaults.ts";
import type { TelemetryKind } from "./events.ts";
import { loadOrCreateInstallId } from "./install-id.ts";

const DEFAULT_FLUSH_INTERVAL_MS = 30000;

// token 的 $ENV 引用要求整串匹配，避免误伤恰好含 $ 的字面值
const ENV_REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export interface CreateTelemetryRuntimeOptions {
	home?: string;
	kind?: TelemetryKind;
	appVersion: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export interface CreateTelemetryCollectorOptions {
	turnId: string;
	features?: Settings["features"];
}

export interface TelemetryRuntime {
	client: TelemetryClient;
	createCollector(
		session: Session,
		opts: CreateTelemetryCollectorOptions,
	): TelemetryCollector;
}

export function createTelemetryRuntime(
	settings: Settings,
	opts: CreateTelemetryRuntimeOptions,
): TelemetryRuntime | null {
	if (settings.telemetry?.enabled === false) {
		return null;
	}
	const endpoint = resolveEndpoint(settings.telemetry?.endpoint);
	if (endpoint === null) {
		return null;
	}
	const kind = opts.kind ?? "user";
	const client = createTelemetryClient({
		kind,
		installId: loadOrCreateInstallId({ home: opts.home, kind }),
		endpoint,
		appVersion: opts.appVersion,
		token: resolveToken(settings.telemetry?.token),
		enabled: true,
		flushIntervalMs:
			settings.telemetry?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
		fetchImpl: opts.fetchImpl,
		now: opts.now,
	});

	return {
		client,
		createCollector(session, collectorOpts) {
			return createTelemetryCollector({
				session,
				sessionId: session.id,
				turnId: collectorOpts.turnId,
				appVersion: opts.appVersion,
				features: collectorOpts.features,
				now: opts.now,
			});
		},
	};
}

// endpoint 优先级：settings（非空且非纯空白时）> 环境变量 > 源码常量。
// settings 里的空串/空白视为「未配置」，继续向后回退；而空的环境变量会遮挡源码常量
//（`??` 只跳过 undefined，不跳过空串），这是刻意的：显式把环境变量置空等于关闭遥测。
// 最终取值为空或非 http(s) URL 一律视为「未配置」：客户端会无限重试不可达地址，
// 与其让配置错误变成后台噪音，不如直接不启用。
function resolveEndpoint(configured: string | undefined): string | null {
	const settingsEndpoint = configured?.trim() ?? "";
	const raw =
		settingsEndpoint !== ""
			? settingsEndpoint
			: (process.env.HOTPOT_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT);
	const endpoint = raw.trim();
	if (endpoint === "") {
		return null;
	}
	try {
		const url = new URL(endpoint);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}
	} catch {
		return null;
	}
	return endpoint;
}

// token 缺省或引用为空都不算错误：上报照常进行，只是不带 Authorization 头
function resolveToken(configured: string | undefined): string | undefined {
	if (configured === undefined || configured === "") {
		return undefined;
	}
	const match = ENV_REF_PATTERN.exec(configured);
	if (match === null) {
		return configured;
	}
	const name = match[1];
	const value = name === undefined ? undefined : process.env[name];
	return value === undefined || value === "" ? undefined : value;
}
