// worker 内联执行助手：spawn 之后由 delegate（simple 分支）与 spawn_workers（complex 流）复用。
// 组装 worker 角色注册表（无元工具）跑完整个 turn，事件不外传（M2 计划决定 #3），
// 只收集 error 事件用于摘要标注（失败分类法 Task 9 细化）；
// 回收 worker 最后一条 assistant_msg 的文本块作为回传给 main 的摘要。

import {
	type LoopConfig,
	loadSession,
	type ModelTier,
	runTurn,
} from "@hotpot/core";
import { buildRoleSystemPrompt } from "../prompts.ts";
import { createRoleRegistry } from "../registries.ts";
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

// 内联跑完 worker 的整个 turn：任务已作为 user_msg 落盘，这里只组装 LoopConfig 并
// 耗尽 runTurn 的异步迭代；worker 走自己的档位模型（runtime.resolveModel(tier)），
// 不复用 main 的适配器
export async function runWorkerInline(
	runtime: OrchestrationRuntime,
	workerId: string,
	tier: ModelTier,
	signal: AbortSignal,
): Promise<string> {
	const registry = createRoleRegistry("worker", []);
	const resolved = runtime.resolveModel(tier);
	const cfg: LoopConfig = {
		session: runtime.session,
		agentId: workerId,
		adapter: resolved.adapter,
		model: resolved.model,
		apiKey: resolved.apiKey,
		baseUrl: resolved.baseUrl,
		registry,
		approval: runtime.approval,
		cwd: runtime.cwd,
		system: buildRoleSystemPrompt("worker", {
			cwd: runtime.cwd,
			os: process.platform,
			date: new Date().toISOString().slice(0, 10),
			tools: registry.declarations(),
		}),
		tier,
	};
	const failures: string[] = [];
	for await (const event of runTurn(cfg, signal)) {
		if (event.type === "error") {
			failures.push(`${event.error.code}: ${event.error.message}`);
		}
	}
	const summary = await readAgentSummary(runtime.session.filePath, workerId);
	if (failures.length > 0) {
		return `[${workerId} failed] ${failures.join("; ")}`;
	}
	return summary ?? `[${workerId} failed] no assistant text produced`;
}
