// 编排运行时：delegate/spawn_workers/spawn_tasks、plan 流程、inbox 等后续能力都闭包在这个对象上。
// spawn 只负责两件事：按 role 计数分配 agentId（worker-1、task-1…，runtime 生命周期内单调递增不复用），
// 并把 agent_spawn 事件落盘（id/ts 由这里组装，append 本身带 fsync，见 core session/store.ts）。
// spawn 不运行任何 turn —— 回合执行是后续任务的责任。
// resolveModel(tier) 把 settings 里的档位 ModelRef 解析为适配器 + 模型 + 凭证。

import { randomUUID } from "node:crypto";
import type { ApprovalChain, ModelTier, Session, Settings } from "@hotpot/core";
import { type ModelResolution, resolveModel } from "./models.ts";
import type { AgentRole } from "./types.ts";

export interface OrchestrationRuntime {
	readonly session: Session;
	readonly cwd: string;
	readonly approval: ApprovalChain;
	readonly maxParallelTasks: number;
	readonly planMaxRevisions: number;
	resolveModel(tier: ModelTier): ModelResolution;
	spawn(opts: {
		role: AgentRole;
		parentAgentId: string;
		task: string;
		tier: ModelTier;
	}): Promise<{ agentId: string }>;
}

export function createRuntime(opts: {
	session: Session;
	cwd: string;
	approval: ApprovalChain;
	models: Settings["models"];
	maxParallelTasks?: number;
	planMaxRevisions?: number;
}): OrchestrationRuntime {
	// 每个 role 一条计数链：同一 runtime 内单调递增，编号不复用
	const counters = new Map<AgentRole, number>();

	return {
		session: opts.session,
		cwd: opts.cwd,
		approval: opts.approval,
		maxParallelTasks: opts.maxParallelTasks ?? 10,
		planMaxRevisions: opts.planMaxRevisions ?? 3,

		resolveModel(tier: ModelTier): ModelResolution {
			return resolveModel(opts.models[tier]);
		},

		async spawn(spawnOpts: {
			role: AgentRole;
			parentAgentId: string;
			task: string;
			tier: ModelTier;
		}): Promise<{ agentId: string }> {
			const next = (counters.get(spawnOpts.role) ?? 0) + 1;
			counters.set(spawnOpts.role, next);
			const agentId = `${spawnOpts.role}-${next}`;
			await opts.session.append({
				type: "agent_spawn",
				id: randomUUID(),
				ts: new Date().toISOString(),
				parentAgentId: spawnOpts.parentAgentId,
				agentId,
				role: spawnOpts.role,
				task: spawnOpts.task,
				tier: spawnOpts.tier,
			});
			return { agentId };
		},
	};
}
