import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

// 发布包构建：把 @hotpot/* 的 workspace 源码打成一个 ESM bin，外部运行时依赖保持 external；
// 前端产物复制到 dist/web，由 server 静态托管。
export default defineConfig({
	entry: ["src/bin.ts"],
	outDir: "dist",
	format: ["esm"],
	platform: "node",
	target: "node22",
	bundle: true,
	splitting: false,
	clean: true,
	external: ["@hono/node-server", "@modelcontextprotocol/sdk", "hono", "zod"],
	async onSuccess() {
		const webDist = resolve("../web/dist");
		if (!existsSync(webDist)) {
			throw new Error(
				"缺少 Web 产物：请先在仓库根运行 pnpm --filter @hotpot/web build",
			);
		}
		rmSync(resolve("dist/web"), { recursive: true, force: true });
		cpSync(webDist, resolve("dist/web"), { recursive: true });
	},
});
