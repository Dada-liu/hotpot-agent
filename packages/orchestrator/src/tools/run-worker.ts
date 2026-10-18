// 下层 agent 内联执行助手：spawn 之后由 delegate（simple 分支）、spawn_workers（complex 流）
// 复用 worker 版；spawn_tasks 用通用版 runAgentInline 跑每个 task turn。
// 通用版按角色装配注册表（worker 走 createWorkerRegistry —— 闭包绑定了该 worker 的
// spawn_tasks，嵌套拆分才真正可用；task 走 createRoleRegistry 四件套、无派生能力），
// 事件不外传（M2 计划决定 #3），只回收 error 事件、done(aborted) 与收尾 summary，
// 失败标注由调用方按统一 taxonomy 决定（Task 9：`[FAILED] ${agentId}: ${reason}`）。
// M4 Task 2：system prompt 按 features.todo 折入该 agent 的 todo 清单段
// （构建前 foldTodos，关闭开关则不 fold 不出段）。

import {
	featureEnabled,
	foldTodos,
	type LoopConfig,
	loadSession,
	type ModelTier,
	runTurn,
} from "@hotpot/core";
import { buildRoleSystemPrompt } from "../prompts.ts";
import { createRoleRegistry, createWorkerRegistry } from "../registries.ts";
import type { OrchestrationRuntime } from "../runtime.ts";

// 读取指定 agent 最后一条 assistant_msg，拼接其文本块作为回传摘要；
// 没有任何 assistant_msg 或文本块为空时返回 undefined，由调用方标注失败
async function readAgentSummary(
	filePath: string,
	agentId: string,
): Promise<string | undefined> {
	const { events } = await loadSession(filePath);
	const messages = events.filter(
		(e) => e.type === "assistant_msg" && e.agentId === agentId,
	);
	const last = messages[messages.length - 1];
	if (last?.type !== "assistant_msg") return undefined;
	const text = last.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	return text === "" ? undefined : text;
}

// 内联 turn 的结构化回收结果：summary 缺失 / error 事件 / abort 由调用方判失败
export interface InlineTurnOutcome {
	/** 该 agent 最后一条 assistant_msg 的文本块拼接；无 assistant_msg 或纯空文本为 undefined */
	summary: string | undefined;
	/** runTurn 产出的 error 事件，按 `${code}: ${message}` 收集 */
	failures: string[];
	/** turn 是否以 done(aborted) 收尾（贯穿 signal 被 cancel） */
	aborted: boolean;
}

// 内联跑完一个下层 agent 的整个 turn：注册表按角色装配（worker 闭包 spawn_tasks），
// 走自己的档位模型（runtime.resolveModel(tier)），不复用 main 的适配器；
// 耗尽 runTurn 的异步迭代，事件不外传，只回收失败标注所需的三元组
export async function runAgentInline(
	runtime: OrchestrationRuntime,
	agentId: string,
	role: "worker" | "task",
	tier: ModelTier,
	signal: AbortSignal,
): Promise<InlineTurnOutcome> {
	const registry =
		role === "worker"
			? createWorkerRegistry(runtime, { agentId, tier })
			: // task 角色同样应用 decorateWorkerTool：policy 包装对下层 agent 一视同仁
				createRoleRegistry(runtime, role, []);
	const resolved = runtime.resolveModel(tier);
	// M4 Task 2：构建 prompt 前经 loadSession 做一次 foldTodos（与结尾 readAgentSummary
	// 的成本模型一致）；features.todo 关闭时不 fold 也不传，prompt 不出 task-list 段
	const todos = featureEnabled(runtime.features, "todo")
		? foldTodos((await loadSession(runtime.session.filePath)).events, agentId)
		: [];
	const cfg: LoopConfig = {
		session: runtime.session,
		agentId,
		adapter: resolved.adapter,
		model: resolved.model,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		registry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt(
			role,
			{
				cwd: runtime.cwd,
				os: process.platform,
				date: new Date().toISOString().slice(0, 10),
				tools: registry.declarations(),
			},
			{ todos },
		),
		tier,
	};
	const failures: string[] = [];
	let aborted = false;
	for await (const event of runTurn(cfg, signal)) {
		if (event.type === "error") {
			failures.push(`${event.error.code}: ${event.error.message}`);
		}
		if (event.type === "done" && event.stopReason === "aborted") {
			aborted = true;
		}
	}
	const summary = await readAgentSummary(runtime.session.filePath, agentId);
	return { summary, failures, aborted };
}

// 内联跑完 worker 的整个 turn（delegate simple 分支与 spawn_workers 共用）：
// 注册表来自 createWorkerRegistry（含该 worker 的 spawn_tasks），摘要回收失败时按
// `[${workerId} failed] ${reason}` 标注，失败分类法与 spawn_tasks 的 [FAILED] 段对齐
export async function runWorkerInline(
	runtime: OrchestrationRuntime,
	workerId: string,
	tier: ModelTier,
	signal: AbortSignal,
): Promise<string> {
	const outcome = await runAgentInline(
		runtime,
		workerId,
		"worker",
		tier,
		signal,
	);
	if (outcome.aborted) {
		return `[${workerId} failed] aborted`;
	}
	if (outcome.failures.length > 0) {
		return `[${workerId} failed] ${outcome.failures.join("; ")}`;
	}
	return outcome.summary ?? `[${workerId} failed] no assistant text produced`;
}
