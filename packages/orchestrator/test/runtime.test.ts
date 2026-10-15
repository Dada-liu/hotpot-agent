// 运行时测试：createRuntime 的 spawn 落盘、档位模型解析与缺省参数
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApprovalChain,
	createSession,
	type SessionEvent,
	type Settings,
} from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveModel } from "../src/models.ts";
import { createRuntime } from "../src/runtime.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-orchestrator-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

// 三档都指向目录内模型，只有 low 走非 anthropic 协议，便于断言适配器选择
const MODELS: Settings["models"] = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

async function readEvents(filePath: string): Promise<SessionEvent[]> {
	const text = await readFile(filePath, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SessionEvent);
}

describe("createRuntime / spawn", () => {
	it("spawn 落盘 agent_spawn 事件，字段完整，agentId 按 role 计数", async () => {
		const session = await createSession("/tmp/proj", home);
		const rt = createRuntime({
			session,
			cwd: "/tmp/proj",
			approval: new ApprovalChain(),
			models: MODELS,
		});

		const first = await rt.spawn({
			role: "worker",
			parentAgentId: "main",
			task: "实现登录接口",
			tier: "medium",
		});
		expect(first).toEqual({ agentId: "worker-1" });

		const second = await rt.spawn({
			role: "worker",
			parentAgentId: "main",
			task: "实现登出接口",
			tier: "low",
		});
		expect(second).toEqual({ agentId: "worker-2" });

		// 不同 role 计数独立：task 从 task-1 起
		const task = await rt.spawn({
			role: "task",
			parentAgentId: "worker-1",
			task: "补单元测试",
			tier: "low",
		});
		expect(task).toEqual({ agentId: "task-1" });

		const events = await readEvents(session.filePath);
		const spawns = events.filter((e) => e.type === "agent_spawn");
		expect(spawns).toHaveLength(3);

		const [s1, s2, s3] = spawns;
		expect(s1).toMatchObject({
			type: "agent_spawn",
			parentAgentId: "main",
			agentId: "worker-1",
			role: "worker",
			task: "实现登录接口",
			tier: "medium",
		});
		// id/ts 必填：id 为 UUID 形态，ts 为合法 ISO 时间
		expect(s1?.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(Number.isNaN(Date.parse(s1?.ts ?? ""))).toBe(false);
		expect(s2).toMatchObject({ agentId: "worker-2", tier: "low" });
		expect(s3).toMatchObject({
			agentId: "task-1",
			parentAgentId: "worker-1",
			role: "task",
		});
	});

	it("maxParallelTasks / planMaxRevisions 缺省 10 / 3，可显式覆盖", async () => {
		const session = await createSession("/tmp/proj", home);
		const defaults = createRuntime({
			session,
			cwd: "/tmp/proj",
			approval: new ApprovalChain(),
			models: MODELS,
		});
		expect(defaults.maxParallelTasks).toBe(10);
		expect(defaults.planMaxRevisions).toBe(3);

		const custom = createRuntime({
			session,
			cwd: "/tmp/proj",
			approval: new ApprovalChain(),
			models: MODELS,
			maxParallelTasks: 4,
			planMaxRevisions: 5,
		});
		expect(custom.maxParallelTasks).toBe(4);
		expect(custom.planMaxRevisions).toBe(5);
	});
});

describe("runtime.resolveModel", () => {
	it("按 tier 返回对应档位配置的 model id 与适配器", async () => {
		const session = await createSession("/tmp/proj", home);
		const rt = createRuntime({
			session,
			cwd: "/tmp/proj",
			approval: new ApprovalChain(),
			models: MODELS,
		});

		const low = rt.resolveModel("low");
		expect(low.model.id).toBe("deepseek-chat");
		expect(low.adapter.api).toBe("openai-completions");
		expect(low.apiKey).toBe("lk");

		const high = rt.resolveModel("high");
		expect(high.model.id).toBe("claude-sonnet-4-5");
		expect(high.adapter.api).toBe("anthropic-messages");
		expect(high.apiKey).toBe("hk");
	});
});

describe("resolveModel", () => {
	it("目录外 provider 按名字推断协议、给告警且不抛错", () => {
		const resolved = resolveModel({
			provider: "acme",
			model: "acme-1",
			apiKey: "k",
		});
		expect(resolved.adapter.api).toBe("openai-completions");
		expect(resolved.model.contextWindow).toBe(128000);
		expect(resolved.warning).toContain("acme/acme-1");
		expect(resolved.apiKey).toBe("k");
	});
});
