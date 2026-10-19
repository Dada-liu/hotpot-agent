import { describe, expect, it } from "vitest";
import { parseWebArgs } from "../src/web.ts";

describe("parseWebArgs", () => {
	it("默认监听 127.0.0.1 并打开浏览器", () => {
		expect(parseWebArgs([])).toEqual({ hostname: "127.0.0.1", open: true });
	});

	it("解析 port / host / no-open", () => {
		expect(
			parseWebArgs(["--port", "4599", "--host", "0.0.0.0", "--no-open"]),
		).toEqual({ port: 4599, hostname: "0.0.0.0", open: false });
		expect(parseWebArgs(["-p", "0"])).toEqual({
			port: 0,
			hostname: "127.0.0.1",
			open: true,
		});
	});

	it("拒绝非法端口与未知参数", () => {
		expect(() => parseWebArgs(["--port", "abc"])).toThrow(/65535/);
		expect(() => parseWebArgs(["--port", "70000"])).toThrow(/65535/);
		expect(() => parseWebArgs(["--port"])).toThrow(/缺少端口/);
		expect(() => parseWebArgs(["--wat"])).toThrow(/未知参数/);
	});
});
