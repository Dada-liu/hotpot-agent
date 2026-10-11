import { describe, expect, it } from "vitest";

import { findModel, MODELS } from "../src/models.ts";

// 模型目录契约测试：M1 首批 4 个模型必须齐全，且元数据字段合法
describe("MODELS", () => {
	it("至少包含 4 个首批模型", () => {
		expect(MODELS.length).toBeGreaterThanOrEqual(4);
	});

	it.each([
		["anthropic", "claude-sonnet-4-5"],
		["openai", "gpt-4.1"],
		["deepseek", "deepseek-chat"],
		["moonshot", "kimi-k2"],
	])("包含 %s/%s", (provider, id) => {
		const model = MODELS.find((m) => m.provider === provider && m.id === id);
		expect(model).toBeDefined();
	});

	it("每个模型 contextWindow > 0 且 cost.input >= 0", () => {
		for (const model of MODELS) {
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.cost.input).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("findModel", () => {
	it("命中已收录模型", () => {
		const model = findModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(model?.provider).toBe("anthropic");
		expect(model?.id).toBe("claude-sonnet-4-5");
	});

	it("未收录时返回 undefined", () => {
		expect(findModel("x", "y")).toBeUndefined();
	});
});
