import { describe, expect, it } from "vitest";
import { HELP_TEXT, routeArgs } from "../src/cli.ts";

describe("routeArgs", () => {
	it("无参数时默认进入 chat", () => {
		expect(routeArgs([])).toEqual({ kind: "chat", argv: ["chat"] });
	});

	it("显式 chat 子命令原样透传", () => {
		expect(routeArgs(["chat", "--tier", "low"])).toEqual({
			kind: "chat",
			argv: ["chat", "--tier", "low"],
		});
	});

	it("省略 chat 子命令时补全，支持 flag 开头的写法", () => {
		expect(routeArgs(["--session", "/tmp/s.jsonl"])).toEqual({
			kind: "chat",
			argv: ["chat", "--session", "/tmp/s.jsonl"],
		});
	});

	it("web 子命令进入 web", () => {
		expect(routeArgs(["web", "--port", "4599"])).toEqual({
			kind: "web",
			argv: ["--port", "4599"],
		});
	});

	it("help 与 version", () => {
		expect(routeArgs(["help"])).toEqual({ kind: "help" });
		expect(routeArgs(["--help"])).toEqual({ kind: "help" });
		expect(routeArgs(["web", "--help"])).toEqual({ kind: "help" });
		expect(routeArgs(["-v"])).toEqual({ kind: "version" });
	});

	it("未知命令返回错误分支", () => {
		expect(routeArgs(["nope"])).toEqual({
			kind: "error",
			command: "nope",
		});
	});

	it("帮助文本同时列出 chat 与 web", () => {
		expect(HELP_TEXT).toContain("hotpot chat");
		expect(HELP_TEXT).toContain("hotpot web");
	});
});
