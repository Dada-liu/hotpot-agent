import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 所有包的测试统一从根目录跑：packages/*/test 与根级 benchmarks/test
export default defineConfig({
	resolve: {
		// 镜像 packages/web/vite.config.ts 的 @ alias：web 组件源码在 node 测试
		// 环境下也要能解析 @/lib、@/components 等导入
		alias: {
			"@": fileURLToPath(new URL("./packages/web/src", import.meta.url)),
		},
	},
	test: {
		include: ["packages/*/test/**/*.test.ts", "benchmarks/test/**/*.test.ts"],
	},
});
