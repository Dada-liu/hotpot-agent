// 套件测试：默认套件必须是固定、唯一的 id 清单。
// 只断言「题量与唯一性」而不是具体 id 内容：换题是产品决定，但重复/缺题一定是 bug。

import { describe, expect, it } from "vitest";
import { DEFAULT_SUITE_NAME, loadBenchSuite } from "../src/suites.ts";

describe("loadBenchSuite", () => {
	it("默认套件 lite10 固定 10 题且 id 不重复", async () => {
		const suite = await loadBenchSuite();
		expect(DEFAULT_SUITE_NAME).toBe("lite10");
		expect(suite.instanceIds).toHaveLength(10);
		expect(new Set(suite.instanceIds).size).toBe(10);
		expect(suite.dataset).toBe("SWE-bench/SWE-bench_Lite");
		expect(suite.split).toBe("test");
	});

	it("两次加载返回同一份缓存对象", async () => {
		const first = await loadBenchSuite("lite10");
		const second = await loadBenchSuite("lite10");
		expect(second).toBe(first);
	});

	it("未知套件与非法名字给出可读报错", async () => {
		await expect(loadBenchSuite("nope")).rejects.toThrow(/not found/);
		await expect(loadBenchSuite("../secrets")).rejects.toThrow(
			/invalid suite name/,
		);
	});
});
