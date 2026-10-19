// server 启动装配：dev bin 与发布包 hotpot web 共用同一套 SessionManager + Hono + 静态托管接线。
// 默认静态目录按源码布局解析（本文件位于 packages/server/src，向上三级即仓库根）；
// 发布包会显式传入打包后的 dist/web，不依赖该默认值。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createSessionManager } from "./session-manager.ts";
import { mountStatic } from "./static.ts";

export interface StartServerOptions {
	port?: number;
	hostname?: string;
	webDist?: string;
	publicDir?: string;
	onListening?: (info: { port: number }) => void;
}

export type HotpotServer = ReturnType<typeof serve>;

function defaultRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function startServer(opts: StartServerOptions = {}): HotpotServer {
	const root = defaultRoot();
	const app = createApp(createSessionManager({}));
	mountStatic(app, {
		webDist:
			opts.webDist ??
			process.env.HOTPOT_WEB_DIST ??
			join(root, "packages", "web", "dist"),
		publicDir:
			opts.publicDir ?? process.env.HOTPOT_PUBLIC_DIR ?? join(root, "public"),
	});
	return serve(
		{
			fetch: app.fetch,
			port: opts.port ?? Number(process.env.HOTPOT_PORT ?? 4573),
			hostname: opts.hostname,
		},
		(info) => opts.onListening?.({ port: info.port }),
	);
}
