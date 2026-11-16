// server/web 启动参数的共享解析：dev bin（packages/server/src/bin.ts）与发布包 hotpot web 共用。
// 纯函数、无外部依赖，保证两个入口的 --port/--host/--no-open 语义一致。
export interface ServeCliArgs {
	port?: number;
	hostname: string;
	open: boolean;
}

const USAGE = "用法: hotpot web [--port <n>] [--host <addr>] [--no-open]";

export function parseServeArgs(argv: string[]): ServeCliArgs {
	const args: ServeCliArgs = { hostname: "127.0.0.1", open: true };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--port" || flag === "-p") {
			const value = argv[i + 1];
			if (value === undefined) {
				throw new Error(`--port 缺少端口参数\n${USAGE}`);
			}
			const port = Number(value);
			if (!Number.isInteger(port) || port < 0 || port > 65535) {
				throw new Error(`--port 只接受 0-65535 的整数\n${USAGE}`);
			}
			args.port = port;
			i += 1;
		} else if (flag === "--host") {
			const value = argv[i + 1];
			if (value === undefined || value === "") {
				throw new Error(`--host 缺少地址参数\n${USAGE}`);
			}
			args.hostname = value;
			i += 1;
		} else if (flag === "--no-open") {
			args.open = false;
		} else {
			throw new Error(`未知参数: ${flag}\n${USAGE}`);
		}
	}
	return args;
}
