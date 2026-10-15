// createTerminalPlanApproval 测试：plan 审批的终端交互裁决映射。
// y/yes → approve；n/no → reject(note 为空串)；其他非空行 → annotate(note)；
// 空行/EOF → reject（fail-closed）。计划全文与提示语打印到输出，便于用户就地审阅。

import { describe, expect, it } from "vitest";
import type { ChatInput, ChatOutput } from "../src/chat.ts";
import { createTerminalPlanApproval } from "../src/plan-approval.ts";

class ScriptedInput implements ChatInput {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = [...lines];
	}

	readLine(): Promise<string | null> {
		return Promise.resolve(this.lines.shift() ?? null);
	}

	setInterruptHandler(_cb: (() => void) | null): void {}

	close(): void {}
}

class CollectedOutput implements ChatOutput {
	text = "";

	write(s: string): void {
		this.text += s;
	}
}

const PLAN = "Step 1: read files\nStep 2: write report";

async function decide(
	lines: string[],
	plan: string = PLAN,
): Promise<{ decision: unknown; output: string }> {
	const output = new CollectedOutput();
	const approve = createTerminalPlanApproval(new ScriptedInput(lines), output);
	const decision = await approve(plan);
	return { decision, output: output.text };
}

describe("createTerminalPlanApproval", () => {
	it("输入 y → approve，且打印 plan 全文与提示语", async () => {
		const { decision, output } = await decide(["y"]);
		expect(decision).toEqual({ kind: "approve" });
		expect(output).toContain(PLAN);
		expect(output).toContain("批准输入 y，拒绝输入 n，批注直接输入内容回车");
	});

	it("输入 n → reject（note 为空串）", async () => {
		const { decision } = await decide(["n"]);
		expect(decision).toEqual({ kind: "reject", note: "" });
	});

	it("输入批注内容 → annotate(note)", async () => {
		const { decision } = await decide(["加测试"]);
		expect(decision).toEqual({ kind: "annotate", note: "加测试" });
	});

	it("EOF → reject（fail-closed）", async () => {
		const { decision } = await decide([]);
		expect(decision).toEqual({ kind: "reject", note: "" });
	});

	it("空行 → reject（fail-closed）", async () => {
		const { decision } = await decide([""]);
		expect(decision).toEqual({ kind: "reject", note: "" });
	});

	it("yes/no 大小写不敏感，批注保留原样", async () => {
		expect((await decide(["YES"])).decision).toEqual({ kind: "approve" });
		expect((await decide(["No"])).decision).toEqual({
			kind: "reject",
			note: "",
		});
		const annotated = await decide(["  补充边界用例  "]);
		expect(annotated.decision).toEqual({
			kind: "annotate",
			note: "补充边界用例",
		});
	});
});
