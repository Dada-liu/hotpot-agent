// 遥测只读客户端：把「拉远程遥测数据」从网页点击变成可脚本化的一步。
//
// 服务端所有读接口（/api/v1/benchmarks、/export、/overview）都挂在 admin 会话下，
// 没有独立的只读 token。因此这里走「密码换 7 天 cookie」，凭据只从环境变量读、
// 只存在进程内存里，绝不写进台账、日志或命令行输出。
// 写入侧（@hotpot/telemetry）与此完全解耦：上报用 ingestToken，读用 admin 会话。
//
// 客户端不猜数据：响应按 schema 校验，字段缺失或形状不对直接报错，
// 避免拿一份旧版本服务端的响应算出「远端通过率 55%」这种看似合理的结论。

import { DEFAULT_TELEMETRY_ENDPOINT } from "@hotpot/telemetry";
import { z } from "zod";

export const DEFAULT_READ_PASSWORD_ENV = "HOTPOT_TELEMETRY_ADMIN_PASSWORD";
const DEFAULT_TIMEOUT_MS = 15_000;

export type ReadErrorKind =
	| "credentials"
	| "unauthorized"
	| "rate_limited"
	| "network"
	| "timeout"
	| "http"
	| "invalid_response";

export class TelemetryReadError extends Error {
	readonly kind: ReadErrorKind;
	readonly status?: number;

	constructor(kind: ReadErrorKind, message: string, status?: number) {
		super(message);
		this.name = "TelemetryReadError";
		this.kind = kind;
		this.status = status;
	}
}

const remoteRunSchema = z.object({
	runId: z.string(),
	benchmark: z.string().nullish(),
	dataset: z.string().nullish(),
	split: z.string().nullish(),
	commit: z.string().nullish(),
	model: z.string().nullish(),
	tier: z.string().nullish(),
	tasksetHash: z.string().nullish(),
	firstSeen: z.string().nullish(),
	lastSeen: z.string().nullish(),
	instances: z.number(),
	attempts: z.number(),
	passed: z.number(),
	passRate: z.number().nullable(),
	resolvedInstances: z.number(),
	flakyInstances: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	avgDurationMs: z.number().nullish(),
	tokensPerResolved: z.number().nullable(),
});

const attemptDetailSchema = z.object({
	attempt: z.number(),
	passed: z.boolean(),
	errorClass: z.string().nullable(),
	durationMs: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	ts: z.string(),
});

const instanceSummarySchema = z.object({
	instanceId: z.string(),
	attempts: z.number(),
	passed: z.number(),
	passRate: z.number().nullable(),
	flaky: z.boolean(),
	details: z.array(attemptDetailSchema),
});

const runDetailSchema = z.object({
	runId: z.string(),
	instances: z.array(instanceSummarySchema),
	truncated: z.boolean(),
});

export type RemoteBenchmarkRun = z.infer<typeof remoteRunSchema>;
export type RemoteRunDetail = z.infer<typeof runDetailSchema>;

export interface QueryWindow {
	from: string;
	to: string;
}

export interface TelemetryReadClientOptions {
	// 默认取 HOTPOT_TELEMETRY_ENDPOINT，再回落 DEFAULT_TELEMETRY_ENDPOINT
	endpoint?: string;
	// 显式传入仅用于测试；生产路径一律从环境变量取
	password?: string;
	passwordEnv?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
}

function normalizeEndpoint(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//.test(trimmed)) {
		throw new TelemetryReadError(
			"invalid_response",
			`遥测地址必须是 http(s) URL：${value}`,
		);
	}
	return trimmed;
}

function errorForStatus(status: number, what: string): TelemetryReadError {
	if (status === 401 || status === 403) {
		return new TelemetryReadError(
			"unauthorized",
			`${what} 被拒绝（${status}）：admin 密码不对、会话过期，或服务端换了鉴权方式`,
			status,
		);
	}
	if (status === 429) {
		return new TelemetryReadError(
			"rate_limited",
			`${what} 被限流（429）：登录接口 10 次/分钟，稍后重试`,
			status,
		);
	}
	return new TelemetryReadError("http", `${what} 返回 HTTP ${status}`, status);
}

export class TelemetryReadClient {
	readonly endpoint: string;
	private readonly cookie: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	private constructor(
		endpoint: string,
		cookie: string,
		fetchImpl: typeof fetch,
		timeoutMs: number,
	) {
		this.endpoint = endpoint;
		this.cookie = cookie;
		this.fetchImpl = fetchImpl;
		this.timeoutMs = timeoutMs;
	}

	static async login(
		options: TelemetryReadClientOptions = {},
	): Promise<TelemetryReadClient> {
		const env = options.env ?? process.env;
		const endpoint = normalizeEndpoint(
			options.endpoint ||
				env.HOTPOT_TELEMETRY_ENDPOINT ||
				DEFAULT_TELEMETRY_ENDPOINT,
		);
		const passwordEnv = options.passwordEnv ?? DEFAULT_READ_PASSWORD_ENV;
		const password = options.password ?? env[passwordEnv];
		if (password === undefined || password.trim() === "") {
			throw new TelemetryReadError(
				"credentials",
				`未设置 ${passwordEnv}：遥测读接口需要 admin 登录。\n  export ${passwordEnv}='<admin 密码>'（不要写进仓库或命令行历史）`,
			);
		}
		const fetchImpl = options.fetchImpl ?? fetch;
		let response: Response;
		try {
			response = await fetchImpl(`${endpoint}/api/v1/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ password }),
				signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			});
		} catch (err) {
			throw wrapNetwork(err, `${endpoint}/api/v1/login`);
		}
		if (!response.ok) {
			throw errorForStatus(response.status, "遥测登录");
		}
		// Node 22 的 Headers 有 getSetCookie()；老环境退回 get("set-cookie")。
		// 只读客户端不持久化 cookie：每次命令重新登录，避免凭据落盘。
		const headers = response.headers as Headers & {
			getSetCookie?: () => string[];
		};
		const cookies =
			typeof headers.getSetCookie === "function"
				? headers.getSetCookie()
				: [response.headers.get("set-cookie") ?? ""];
		const admin = cookies
			.map((value) => value.split(";")[0]?.trim() ?? "")
			.find((value) => value.startsWith("hp_admin="));
		if (admin === undefined || admin.length === "hp_admin=".length) {
			throw new TelemetryReadError(
				"invalid_response",
				"登录成功但没有拿到 hp_admin cookie：检查服务端版本与 auth 配置",
			);
		}
		return new TelemetryReadClient(
			endpoint,
			admin,
			fetchImpl,
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
	}

	async healthz(): Promise<boolean> {
		try {
			const response = await this.fetchImpl(`${this.endpoint}/healthz`, {
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/** 按 runId 聚合的跑批列表；时间窗口必须覆盖跑批事件，否则服务端查不到。 */
	async benchmarkRuns(window: QueryWindow): Promise<RemoteBenchmarkRun[]> {
		const data = await this.getJson("/api/v1/benchmarks", window, "跑批列表");
		const parsed = z.array(remoteRunSchema).safeParse(data);
		if (!parsed.success) {
			throw new TelemetryReadError(
				"invalid_response",
				`跑批列表形状不对（服务端可能是旧版本）：${parsed.error.issues
					.slice(0, 3)
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; ")}`,
			);
		}
		return parsed.data;
	}

	/** 某一轮的逐题汇总 + 每次尝试明细。 */
	async benchmarkRunDetail(
		runId: string,
		window: QueryWindow,
	): Promise<RemoteRunDetail> {
		const data = await this.getJson(
			`/api/v1/benchmarks/${encodeURIComponent(runId)}/instances`,
			window,
			`跑批 ${runId} 明细`,
		);
		const parsed = runDetailSchema.safeParse(data);
		if (!parsed.success) {
			throw new TelemetryReadError(
				"invalid_response",
				`跑批明细形状不对（服务端可能是旧版本）：${parsed.error.issues
					.slice(0, 3)
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; ")}`,
			);
		}
		return parsed.data;
	}

	private async getJson(
		path: string,
		window: QueryWindow,
		what: string,
	): Promise<unknown> {
		const params = new URLSearchParams({
			kind: "benchmark",
			from: window.from,
			to: window.to,
		});
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.endpoint}${path}?${params}`, {
				headers: { cookie: this.cookie },
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			throw wrapNetwork(err, `${this.endpoint}${path}`);
		}
		if (!response.ok) {
			throw errorForStatus(response.status, what);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new TelemetryReadError(
				"invalid_response",
				`${what} 返回的不是 JSON`,
			);
		}
		if (typeof body !== "object" || body === null || !("data" in body)) {
			throw new TelemetryReadError(
				"invalid_response",
				`${what} 缺少 data 字段`,
			);
		}
		return (body as { data: unknown }).data;
	}
}

function wrapNetwork(err: unknown, url: string): TelemetryReadError {
	const message = err instanceof Error ? err.message : String(err);
	if (/timeout|abort/i.test(message)) {
		return new TelemetryReadError("timeout", `请求超时：${url}（${message}）`);
	}
	return new TelemetryReadError("network", `连不上 ${url}：${message}`);
}

/** 默认查询窗口：覆盖本地登记时间前后，避免服务端 LIMIT 200 把目标轮挤掉。 */
export function defaultQueryWindow(
	recordedAt: readonly string[],
	now: Date,
): QueryWindow {
	const times = recordedAt
		.map((value) => Date.parse(value))
		.filter((value) => Number.isFinite(value));
	const earliest = times.length > 0 ? Math.min(...times) : now.getTime();
	const latest = Math.max(now.getTime(), ...times);
	return {
		from: new Date(earliest - 2 * 24 * 60 * 60 * 1000).toISOString(),
		to: new Date(latest + 24 * 60 * 60 * 1000).toISOString(),
	};
}
