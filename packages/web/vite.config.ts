import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 静态资产不搬迁：直接复用仓库根 public/（logo 与各 agent 形象图）
export default defineConfig({
	publicDir: "../../public",
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			// shadcn/ui 组件使用 @/ 别名（components.json 与 tsconfig paths 同步维护）
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	server: {
		// 开发态 API 转发到本地 hotpot-server
		proxy: {
			"/api": {
				target: "http://localhost:4573",
				changeOrigin: true,
			},
		},
	},
});
