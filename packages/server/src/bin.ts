#!/usr/bin/env tsx
// hotpot-server 启动入口：装配 SessionManager + Hono app，经 @hono/node-server 监听。
// 端口取 HOTPOT_PORT（缺省 4573）；监听地址在 listening 回调里打印（取实际端口）。
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createSessionManager } from "./session-manager.ts";

const port = Number(process.env.HOTPOT_PORT ?? 4573);
const manager = createSessionManager({});
const app = createApp(manager);

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`hotpot-server listening on http://localhost:${info.port}`);
});
