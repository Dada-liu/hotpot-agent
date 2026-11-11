// 无交互 agent runner：为 benchmark 跑一个完整 task turn。
// 与 CLI 共用 core/orchestrator 的装配，但刻意收紧：
// - 临时 HOTPOT_HOME（mkdtemp），不污染用户会话与 telemetry 安装 ID；
// - 显式 allow-all 工具审批（经 audited 包装落盘 asked/decided），plan 自动批准；
//   不用 permission.mode 门控（基准场景要求零打断，显式链头放行语义更直接）；
// - 装配参数来自 runtime profile（默认 BENCHMARK_RUNTIME：特性全关、串行、patch-only），
//   不再写死在函数里——否则报告无从判断两次跑批是否同一条件；
// - 只回传 outcome、整棵树的 token（含分档位分解）、时长与会话路径，不把对话内容带回上层。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter, ModelInfo } from "@hotpot/ai";
import {
	ApprovalChain,
	createAuditedApprovalChain,
	createSession,
	loadSession,
	loadSettings,
	type ModelTier,
	type Settings,
} from "@hotpot/core";
import {
	createRuntime,
	type OrchestrationRuntime,
	runMainTurn,
} from "@hotpot/orchestrator";
import {
	BENCHMARK_RUNTIME,
	type BenchmarkRuntime,
	runtimeFeatures,
} from "./runtime-profile.ts";
import {
	addTierUsage,
	createTierTokens,
	type TierTokens,
	tierTokensTotal,
} from "./tokens.ts";

export interface RunAgentTurnOptions {
	cwd: string;
	prompt: string;
	// 默认加载用户级 settings（真实跑批）；测试注入内存配置
	settings?: Settings;
	modelTier: ModelTier;
	timeoutMs?: number;
	// 默认 BENCHMARK_RUNTIME；能力档位/消融实验经此替换
	profile?: BenchmarkRuntime;
	// 测试注入：两者同时提供时覆盖全部档位的模型解析
	adapter?: LlmAdapter;
	model?: ModelInfo;
}

export interface AgentTurnResult {
	outcome: "success" | "error" | "aborted";
	inputTokens: number;
	outputTokens: number;
	// 同一批 token 按模型档位切开，用于成本归因
	tokensByTier: TierTokens;
	durationMs: number;
	sessionFilePath: string;
	error?: string;
}

export async function runAgentTurn(
	opts: RunAgentTurnOptions,
): Promise<AgentTurnResult> {
	const started = Date.now();
	const profile = opts.profile ?? BENCHMARK_RUNTIME;
	// 自动批准写在这里而不是配置里：真放开审批等待，跑批会静默挂住，
	// 所以换 profile 时必须显式改 runner，而不是让一个布尔值悄悄改变语义。
	if (!profile.planAutoApprove) {
		throw new Error(
			"benchmark runner only supports plan auto-approve; a profile that waits for approval cannot run unattended",
		);
	}

	const settings = opts.settings ?? loadSettings();
	const home = await mkdtemp(join(tmpdir(), "hotpot-bench-"));
	const session = await createSession(opts.cwd, home);

	const allowAll = new ApprovalChain();
	allowAll.use(async () => "allow");
	const approval = createAuditedApprovalChain(allowAll, {
		session,
		agentId: "main",
	});

	const baseRuntime = createRuntime({
		session,
		cwd: opts.cwd,
		approval,
		models: settings.models,
		maxParallelTasks: profile.maxParallelTasks,
		features: runtimeFeatures(profile),
	});
	const injectedAdapter = opts.adapter;
	const injectedModel = opts.model;
	const orchestration: OrchestrationRuntime =
		injectedAdapter !== undefined && injectedModel !== undefined
			? {
					...baseRuntime,
					resolveModel: () => ({
						adapter: injectedAdapter,
						model: injectedModel,
						apiKey: "test",
					}),
				}
			: baseRuntime;

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		opts.timeoutMs ?? profile.timeoutMs,
	);
	let stopReason: string | undefined;
	let sawError = false;
	let errorMessage: string | undefined;

	try {
		for await (const event of runMainTurn({
			runtime: orchestration,
			userMessage: opts.prompt,
			signal: controller.signal,
			mainTier: opts.modelTier,
			onPlanApproval: async () => ({ kind: "approve" }),
		})) {
			if (event.type === "done") {
				stopReason = event.stopReason;
			} else if (event.type === "error") {
				sawError = true;
				errorMessage ??= event.error.message;
			}
		}
	} catch (err) {
		sawError = true;
		errorMessage = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timer);
	}

	const tokensByTier = await sumUsage(session.filePath);
	const usage = tierTokensTotal(tokensByTier);
	const outcome = controller.signal.aborted
		? "aborted"
		: sawError || stopReason !== "stop"
			? "error"
			: "success";
	if (outcome === "error" && errorMessage === undefined) {
		errorMessage =
			stopReason === undefined
				? "turn ended without a done event"
				: `turn ended with stop reason ${stopReason}`;
	}
	if (outcome === "aborted" && errorMessage === undefined) {
		errorMessage = "turn aborted";
	}

	return {
		outcome,
		inputTokens: usage.input,
		outputTokens: usage.output,
		tokensByTier,
		durationMs: Date.now() - started,
		sessionFilePath: session.filePath,
		...(errorMessage === undefined ? {} : { error: errorMessage }),
	};
}

// 从会话日志折叠整棵 agent 树（main + worker + task）的 assistant usage，并按 tier 分开。
// 日志损坏时按 0 计，不掩盖 runner 的 outcome。
async function sumUsage(filePath: string): Promise<TierTokens> {
	const tokens = createTierTokens();
	try {
		const { events } = await loadSession(filePath);
		for (const event of events) {
			if (event.type !== "assistant_msg") {
				continue;
			}
			addTierUsage(tokens, event.tier, event.usage);
		}
	} catch {
		// 读不到日志：token 记 0
	}
	return tokens;
}
