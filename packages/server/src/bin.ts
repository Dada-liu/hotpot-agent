#!/usr/bin/env tsx
// hotpot-server 启动入口：dev 态直接复用 startServer 的默认静态目录解析。
import { startServer } from "./serve.ts";

startServer({
	onListening: (info) => {
		console.log(`hotpot-server listening on http://localhost:${info.port}`);
	},
});
