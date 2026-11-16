import { describe, expect, it } from "vitest";
import { formatWebUrl } from "../src/web.ts";

describe("formatWebUrl", () => {
	it("携带 token，并把通配监听地址转换为可连接地址", () => {
		expect(formatWebUrl("0.0.0.0", 4573, "token /+")).toBe(
			"http://localhost:4573?token=token%20%2F%2B",
		);
		expect(formatWebUrl("::", 4573, "secret")).toBe(
			"http://localhost:4573?token=secret",
		);
	});

	it("为 IPv6 地址添加方括号", () => {
		expect(formatWebUrl("::1", 4573, "secret")).toBe(
			"http://[::1]:4573?token=secret",
		);
	});
});
