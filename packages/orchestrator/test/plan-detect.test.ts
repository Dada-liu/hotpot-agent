// detectPlanDraft 测试：计划标记校验与扫描窗口（最后一条 main user_msg 之后，
// 取最新一条带标记的 main assistant_msg——同轮「计划正文 + 后续补充说明」也能命中）。
// 钉住行为：带 `# Plan` 标记且含三个必备段落（Steps/Files/Acceptance criteria）
// 才算计划草稿；普通回答、缺段落、窗口外的旧计划、纯空白一律 null。
// prompts 的计划格式模板含全部四个标题。会话事件直接经 session.append 落盘，
// 不触发任何 LLM 调用（hermetic）。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalChain, createSession } from "@hotpot/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectPlanDraft } from "../src/plan/plan.ts";
import { PLAN_FORMAT_TEMPLATE } from "../src/prompts/prompts.ts";
import {
	createRuntime,
	type OrchestrationRuntime,
} from "../src/runtime/runtime.ts";

let home: string;
let proj: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-plan-detect-home-"));
	proj = await mkdtemp(join(tmpdir(), "hotpot-plan-detect-proj-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(proj, { recursive: true, force: true });
});

const MODELS = {
	high: { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "hk" },
	medium: { provider: "openai", model: "gpt-4.1", apiKey: "mk" },
	low: { provider: "deepseek", model: "deepseek-chat", apiKey: "lk" },
};

async function makeRuntime(): Promise<OrchestrationRuntime> {
	const session = await createSession(proj, home);
	return createRuntime({
		session,
		cwd: proj,
		approval: new ApprovalChain(),
		models: MODELS,
	});
}

async function appendUserMsg(
	runtime: OrchestrationRuntime,
	content: string,
): Promise<void> {
	await runtime.session.append({
		type: "user_msg",
		id: crypto.randomUUID(),
		ts: new Date().toISOString(),
		agentId: "main",
		content,
	});
}

async function appendAssistantText(
	runtime: OrchestrationRuntime,
	text: string,
): Promise<string> {
	const id = crypto.randomUUID();
	await runtime.session.append({
		type: "assistant_msg",
		id,
		ts: new Date().toISOString(),
		agentId: "main",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5 },
		model: "claude-sonnet-4-5",
		tier: "high",
	});
	return id;
}

const VALID_PLAN = `# Plan

## Steps
1. add auth routes

## Files
auth.ts

## Acceptance criteria
tests pass
`;

describe("detectPlanDraft", () => {
	it("合法计划：# Plan 开头且含三个必备段落，返回消息 id 与全文", async () => {
		const runtime = await makeRuntime();
		await appendUserMsg(runtime, "给项目加用户认证");
		const id = await appendAssistantText(runtime, VALID_PLAN);

		const draft = await detectPlanDraft(runtime);

		expect(draft).toEqual({ id, text: VALID_PLAN });
	});

	it("缺任一必备段落（无 Acceptance criteria）返回 null", async () => {
		const runtime = await makeRuntime();
		await appendUserMsg(runtime, "给项目加用户认证");
		await appendAssistantText(
			runtime,
			"# Plan\n\n## Steps\n1. add auth routes\n\n## Files\nauth.ts\n",
		);

		expect(await detectPlanDraft(runtime)).toBeNull();
	});

	it("普通回答（不以 # Plan 开头）返回 null", async () => {
		const runtime = await makeRuntime();
		await appendUserMsg(runtime, "1+1 等于几");
		await appendAssistantText(runtime, "答案是 42。");

		expect(await detectPlanDraft(runtime)).toBeNull();
	});

	it("最后一条 main user_msg 之前的旧计划（上一轮）不计入，返回 null", async () => {
		const runtime = await makeRuntime();
		await appendUserMsg(runtime, "给项目加用户认证");
		await appendAssistantText(runtime, VALID_PLAN);
		// 新一轮用户消息 + 普通回答：窗口起点移动后旧计划不可见
		await appendUserMsg(runtime, "1+1 等于几");
		await appendAssistantText(runtime, "答案是 42。");

		expect(await detectPlanDraft(runtime)).toBeNull();
	});

	it("纯空白文本返回 null", async () => {
		const runtime = await makeRuntime();
		await appendUserMsg(runtime, "给项目加用户认证");
		await appendAssistantText(runtime, "   \n\n ");

		expect(await detectPlanDraft(runtime)).toBeNull();
	});

	it("多条 assistant 取最新一条带标记的：旧消息带标记也算产出计划", async () => {
		const runtime = await makeRuntime();
		await appendUserMsg(runtime, "给项目加用户认证");
		await appendAssistantText(runtime, "先想想。");
		const id = await appendAssistantText(runtime, VALID_PLAN);
		expect(await detectPlanDraft(runtime)).toEqual({ id, text: VALID_PLAN });

		// 「计划正文 + 同轮工具调用被守卫拦截后的补充说明」形态：
		// 计划标记在较早消息里，窗口内任一消息带标记即视为产出计划
		const runtime2 = await makeRuntime();
		await appendUserMsg(runtime2, "给项目加用户认证");
		const id2 = await appendAssistantText(runtime2, VALID_PLAN);
		await appendAssistantText(runtime2, "补充：等待审批。");
		expect(await detectPlanDraft(runtime2)).toEqual({
			id: id2,
			text: VALID_PLAN,
		});
	});

	it("CRLF 换行的计划文本也能命中（模型输出可能出现 \\r\\n）", async () => {
		const runtime = await makeRuntime();
		await appendUserMsg(runtime, "给项目加用户认证");
		const id = await appendAssistantText(
			runtime,
			VALID_PLAN.replace(/\n/g, "\r\n"),
		);

		const draft = await detectPlanDraft(runtime);
		expect(draft?.id).toBe(id);
	});

	it("PLAN_FORMAT_TEMPLATE 含 # Plan 与三个必备段落标题", async () => {
		expect(PLAN_FORMAT_TEMPLATE).toContain("# Plan");
		expect(PLAN_FORMAT_TEMPLATE).toContain("## Steps");
		expect(PLAN_FORMAT_TEMPLATE).toContain("## Files");
		expect(PLAN_FORMAT_TEMPLATE).toContain("## Acceptance criteria");
	});
});
