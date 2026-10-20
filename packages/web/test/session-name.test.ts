import { describe, expect, it } from "vitest";
import { sessionNameFromPrompt } from "../src/lib/session-name.ts";

describe("sessionNameFromPrompt", () => {
	it("普通提示词原样返回", () => {
		expect(sessionNameFromPrompt("帮我重构登录模块")).toBe("帮我重构登录模块");
	});

	it("多行取第一行", () => {
		expect(sessionNameFromPrompt("第一行\n第二行")).toBe("第一行");
	});

	it("去掉首尾空白", () => {
		expect(sessionNameFromPrompt("   spaced  ")).toBe("spaced");
	});

	it("超长不截断，原样返回（截断交给展示侧 CSS 省略号）", () => {
		const long = "a".repeat(30);
		expect(sessionNameFromPrompt(long)).toBe(long);
	});

	it("空与纯空白回退为“新会话”", () => {
		expect(sessionNameFromPrompt("")).toBe("新会话");
		expect(sessionNameFromPrompt("   \n  ")).toBe("新会话");
	});
});
