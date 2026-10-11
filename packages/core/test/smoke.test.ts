import { describe, expect, it } from "vitest";

// 冒烟测试：验证测试管线（vitest 配置、workspace 解析）可用
describe("smoke", () => {
	it("pipeline works", () => {
		expect(1 + 1).toBe(2);
	});
});
