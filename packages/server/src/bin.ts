#!/usr/bin/env tsx
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// hotpot-server 启动入口：装配 SessionManager + Hono app，经 @hono/node-server 监听。
// 端口取 HOTPOT_PORT（缺省 4573）；监听地址在 listening 回调里打印（取实际端口）。
// 静态托管：web 产物 <仓库根>/packages/web/dist 与根 public/，
// 可用 HOTPOT_WEB_DIST / HOTPOT_PUBLIC_DIR 覆盖；目录不存在则纯 API 模式。
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createSessionManager } from "./session-manager.ts";
import { mountStatic } from "./static.ts";

const port = Number(process.env.HOTPOT_PORT ?? 4573);
const manager = createSessionManager({});
const app = createApp(manager);

// bin 直跑场景：import.meta.url 位于 <仓库根>/packages/server/src，向上三级即仓库根
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
mountStatic(app, {
	webDist:
		process.env.HOTPOT_WEB_DIST ?? join(repoRoot, "packages", "web", "dist"),
	publicDir: process.env.HOTPOT_PUBLIC_DIR ?? join(repoRoot, "public"),
});

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`hotpot-server listening on http://localhost:${info.port}`);
});
