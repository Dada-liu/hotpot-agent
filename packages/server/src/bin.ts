#!/usr/bin/env tsx
// hotpot-server 启动入口：dev 态直接复用 startServer 的默认静态目录解析。
// 解析与 hotpot web 相同的启动参数（--port/--host/--no-open），--no-open 仅由上层消费，本 bin 不打开浏览器。
import { parseServeArgs, type ServeCliArgs } from "./args.ts";
import { startServer } from "./serve.ts";

let args: ServeCliArgs;
try {
	args = parseServeArgs(process.argv.slice(2));
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
}

startServer({
	port: args.port,
	hostname: args.hostname,
	onListening: (info) => {
		const token = encodeURIComponent(info.apiToken);
		console.log(
			`hotpot-server listening on http://${info.hostname}:${info.port}?token=${token}`,
		);
	},
});
