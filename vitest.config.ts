import { defineConfig } from "vitest/config";

// 所有包的测试统一从根目录跑：packages/*/test/**/*.test.ts
export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
	},
});
