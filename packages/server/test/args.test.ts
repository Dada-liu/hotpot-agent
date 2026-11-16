import { describe, expect, it } from "vitest";
import { parseServeArgs } from "../src/args.ts";

describe("parseServeArgs", () => {
	it("默认监听 127.0.0.1 并打开浏览器", () => {
		expect(parseServeArgs([])).toEqual({
			hostname: "127.0.0.1",
			open: true,
		});
	});

	it("解析 port / host / no-open", () => {
		expect(
			parseServeArgs(["--port", "4599", "--host", "0.0.0.0", "--no-open"]),
		).toEqual({ port: 4599, hostname: "0.0.0.0", open: false });
		expect(parseServeArgs(["-p", "0"])).toEqual({
			port: 0,
			hostname: "127.0.0.1",
			open: true,
		});
	});

	it("拒绝非法端口与未知参数", () => {
		expect(() => parseServeArgs(["--port", "abc"])).toThrow(/65535/);
		expect(() => parseServeArgs(["--port", "70000"])).toThrow(/65535/);
		expect(() => parseServeArgs(["--port"])).toThrow(/缺少端口/);
		expect(() => parseServeArgs(["--wat"])).toThrow(/未知参数/);
	});
});
