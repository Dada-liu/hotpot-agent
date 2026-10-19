// 发布包的命令路由：把 hotpot 的 argv 分派到 chat / web / help / version。
// 路由保持为纯函数，便于测试；真正的进程退出码由 bin.ts 写入 process.exitCode。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChatCli } from "@hotpot/cli";
import { runWebCli } from "./web.ts";

export const HELP_TEXT = `hotpot — 低成本的 code agent

用法:
  hotpot                          启动终端对话
  hotpot chat [--session <path>] [--tier high|medium|low]
  hotpot web [--port <n>] [--host <addr>] [--no-open]
  hotpot --version
  hotpot --help

配置: ~/.hotpot/settings.json`;

export type CliRoute =
	| { kind: "chat"; argv: string[] }
	| { kind: "web"; argv: string[] }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "error"; command: string };

function hasHelpFlag(argv: string[]): boolean {
	return argv.includes("-h") || argv.includes("--help");
}

export function routeArgs(argv: string[]): CliRoute {
	const [first] = argv;
	if (first === undefined) {
		return { kind: "chat", argv: ["chat"] };
	}
	if (first === "web") {
		return hasHelpFlag(argv)
			? { kind: "help" }
			: { kind: "web", argv: argv.slice(1) };
	}
	if (first === "chat") {
		return hasHelpFlag(argv) ? { kind: "help" } : { kind: "chat", argv };
	}
	if (first === "help" || first === "-h" || first === "--help") {
		return { kind: "help" };
	}
	if (first === "-v" || first === "--version") {
		return { kind: "version" };
	}
	// 省略 chat 子命令：hotpot --session <path>
	if (first.startsWith("-")) {
		return { kind: "chat", argv: ["chat", ...argv] };
	}
	return { kind: "error", command: first };
}

// 版本来自发布包的 package.json：源码态位于 src/../package.json，
// 打包后位于 dist/../package.json，两种布局都能命中。
export function packageVersion(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const text = readFileSync(join(here, "..", "package.json"), "utf8");
	const data: unknown = JSON.parse(text);
	if (typeof data === "object" && data !== null && "version" in data) {
		const version = data.version;
		if (typeof version === "string") {
			return version;
		}
	}
	return "unknown";
}

export async function runCli(argv: string[]): Promise<number> {
	const route = routeArgs(argv);
	switch (route.kind) {
		case "chat":
			return runChatCli(route.argv);
		case "web":
			return runWebCli(route.argv);
		case "help":
			process.stdout.write(`${HELP_TEXT}\n`);
			return 0;
		case "version":
			process.stdout.write(`${packageVersion()}\n`);
			return 0;
		case "error":
			process.stderr.write(`未知命令: ${route.command}\n${HELP_TEXT}\n`);
			return 1;
	}
}
