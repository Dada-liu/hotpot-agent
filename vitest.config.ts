import { defineConfig } from "vitest/config";

// 所有包的测试统一从根目录跑：packages/*/test 与根级 benchmarks/test
export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts", "benchmarks/test/**/*.test.ts"],
	},
});
