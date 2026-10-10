import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalChain, type ApprovalRequest } from "../src/approval/chain.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext, ToolDefinition } from "../src/tools/tool.ts";

// 固定 ctx，保证测试确定性；approval 用空链（默认 deny）即可
const CTX: ToolContext = {
	cwd: "/tmp",
	signal: new AbortController().signal,
	approval: new ApprovalChain(),
};

const REQ: ApprovalRequest = {
	kind: "command",
	summary: "run ls",
	detail: "ls -la",
};

function makeReadTool(): ToolDefinition<{ path: string; recursive?: boolean }> {
	return {
		name: "read",
		description: "Read a file from disk",
		parameters: z.object({
			path: z.string().describe("absolute file path"),
			recursive: z.boolean().optional(),
		}),
		execute: async (args) => ({ content: `read ${args.path}` }),
	};
}

describe("ToolRegistry.declarations", () => {
	it("zod schema 转为 JSON Schema：含 type/properties/required，可选字段不进 required", () => {
		const registry = createToolRegistry();
		registry.register(makeReadTool());

		const decls = registry.declarations();
		expect(decls).toHaveLength(1);
		const decl = decls[0];
		expect(decl.name).toBe("read");
		expect(decl.description).toBe("Read a file from disk");
		expect(decl.parameters.type).toBe("object");
		const props = decl.parameters.properties as Record<
			string,
			{ type: string; description?: string }
		>;
		expect(props.path.type).toBe("string");
		expect(props.path.description).toBe("absolute file path");
		expect(props.recursive.type).toBe("boolean");
		expect(decl.parameters.required).toEqual(["path"]);
	});

	it("description 以工具定义字段为准，而非 schema 顶层的 describe", () => {
		const tool: ToolDefinition<{ a: string }> = {
			name: "t",
			description: "tool-level description",
			parameters: z.object({ a: z.string() }).describe("schema-level"),
			execute: async () => ({ content: "ok" }),
		};
		const registry = createToolRegistry();
		registry.register(tool);

		expect(registry.declarations()[0].description).toBe(
			"tool-level description",
		);
	});

	it("顶层非 object 的 schema 在 declarations 时抛错", () => {
		const tool: ToolDefinition<string> = {
			name: "bad",
			description: "bad tool",
			parameters: z.string(),
			execute: async () => ({ content: "ok" }),
		};
		const registry = createToolRegistry();
		registry.register(tool);

		expect(() => registry.declarations()).toThrow(/object/);
	});
});

describe("ToolRegistry register/get", () => {
	it("get 返回已注册工具，未注册返回 undefined", () => {
		const registry = createToolRegistry();
		registry.register(makeReadTool());

		expect(registry.get("read")?.name).toBe("read");
		expect(registry.get("missing")).toBeUndefined();
	});

	it("register 擦除泛型为 unknown，execute 前经 schema 校验并剥离多余字段", async () => {
		let received: unknown;
		const tool: ToolDefinition<{ path: string }> = {
			name: "read",
			description: "Read a file from disk",
			parameters: z.object({ path: z.string() }),
			execute: async (args) => {
				received = args;
				return { content: args.path };
			},
		};
		const registry = createToolRegistry();
		registry.register(tool);

		const erased = registry.get("read");
		expect(erased).toBeDefined();
		const out = await erased?.execute({ path: "a.ts", extra: 1 }, CTX);
		expect(out?.content).toBe("a.ts");
		// z.object 默认剥离未知键，工具实现只见到 schema 声明的字段
		expect(received).toEqual({ path: "a.ts" });
	});

	it("execute 收到不合 schema 的参数时拒绝", async () => {
		const registry = createToolRegistry();
		registry.register(makeReadTool());

		const erased = registry.get("read");
		await expect(erased?.execute({ path: 42 }, CTX)).rejects.toThrow();
	});
});

describe("ApprovalChain", () => {
	it("第一个 handler 返回 next、第二个返回 deny，结果为 deny", async () => {
		const chain = new ApprovalChain();
		const calls: string[] = [];
		chain.use(async () => {
			calls.push("first");
			return "next";
		});
		chain.use(async () => {
			calls.push("second");
			return "deny";
		});

		const decision = await chain.ask(REQ);
		expect(decision).toBe("deny");
		expect(calls).toEqual(["first", "second"]);
	});

	it("全部 handler 返回 next 时默认 deny（fail-closed）", async () => {
		const chain = new ApprovalChain();
		chain.use(async () => "next");
		chain.use(async () => "next");

		expect(await chain.ask(REQ)).toBe("deny");
	});

	it("没有注册任何 handler 时同样默认 deny（fail-closed）", async () => {
		const chain = new ApprovalChain();

		expect(await chain.ask(REQ)).toBe("deny");
	});

	it("handler 返回 allow 即短路，后续 handler 不再询问", async () => {
		const chain = new ApprovalChain();
		let secondCalled = false;
		chain.use(async () => "allow");
		chain.use(async () => {
			secondCalled = true;
			return "deny";
		});

		expect(await chain.ask(REQ)).toBe("allow");
		expect(secondCalled).toBe(false);
	});

	it("ask 将原请求按序透传给每个 handler", async () => {
		const chain = new ApprovalChain();
		const seen: ApprovalRequest[] = [];
		chain.use(async (req) => {
			seen.push(req);
			return "next";
		});
		chain.use(async (req) => {
			seen.push(req);
			return "allow";
		});

		await chain.ask(REQ);
		expect(seen).toEqual([REQ, REQ]);
	});
});
