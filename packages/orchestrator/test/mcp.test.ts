// MCP 桥接与连接层测试：全部注入 stub client/factory，不触真实 MCP server。
// - bridgeMcpTools：命名 mcp__<server>__<tool>、description 透传、execute 转发
//   callTool（原始工具名 + 入参）、content text 块拼接、isError 透传、超时/中止映射
// - server 名非法字符替换为 _ 并 warn
// - 顶层 schema 非 object 时回退空对象 passthrough：声明合规（registry.declarations
//   要求顶层 object）且入参不丢（不拦原则）
// - connectMcpServers：逐 server 隔离（失败 warn+跳过）、stdio/http 分类、
//   listTools 失败关句柄跳过、连接超时经 signal 生效、配置原样传给工厂
// - closeMcpConnections：全量关闭，单个失败不拖垮其余

import {
	ApprovalChain,
	createToolRegistry,
	type Session,
	type ToolContext,
} from "@hotpot/core";
import { describe, expect, it } from "vitest";
import {
	bridgeMcpTools,
	closeMcpConnections,
	connectMcpServers,
	type McpClientHandle,
	type McpConnection,
	type McpToolCallResult,
	type McpToolInfo,
} from "../src/mcp/mcp.ts";

// ---- stub 连接层 ----

interface StubHandle extends McpClientHandle {
	calls: { name: string; args: unknown }[];
	signals: AbortSignal[];
	closeCalls: number;
}

function stubHandle(opts?: {
	tools?: McpToolInfo[];
	callTool?: (
		name: string,
		args: unknown,
		callOpts: { signal: AbortSignal },
	) => Promise<McpToolCallResult>;
}): StubHandle {
	const handle: StubHandle = {
		calls: [],
		signals: [],
		closeCalls: 0,
		async listTools() {
			return opts?.tools ?? [];
		},
		async callTool(name, args, callOpts) {
			handle.calls.push({ name, args });
			handle.signals.push(callOpts.signal);
			if (opts?.callTool) {
				return opts.callTool(name, args, callOpts);
			}
			return { content: [{ type: "text", text: "ok" }] };
		},
		async close() {
			handle.closeCalls += 1;
		},
	};
	return handle;
}

function makeCtx(signal?: AbortSignal): ToolContext {
	const session: Session = {
		id: "test-session",
		filePath: "/tmp/test-session.jsonl",
		append: async () => {},
	};
	return {
		cwd: "/tmp/project",
		signal: signal ?? new AbortController().signal,
		approval: new ApprovalChain(),
		agentId: "worker-1",
		session,
	};
}

// ---- 桥接 ----

describe("bridgeMcpTools 命名与声明", () => {
	it("工具名 mcp__<server>__<tool>，description 透传，isConcurrencySafe=false", () => {
		const handle = stubHandle({
			tools: [
				{
					name: "greet",
					description: "Say hello",
					inputSchema: {
						type: "object",
						properties: { who: { type: "string" } },
						required: ["who"],
					},
				},
			],
		});
		const [tool] = bridgeMcpTools(
			"demo",
			[
				{
					name: "greet",
					description: "Say hello",
					inputSchema: {
						type: "object",
						properties: { who: { type: "string" } },
						required: ["who"],
					},
				},
			],
			handle,
		);
		expect(tool?.name).toBe("mcp__demo__greet");
		expect(tool?.description).toBe("Say hello");
		expect(tool?.isConcurrencySafe).toBe(false);
	});

	it("server 名含非法字符：替换为 _ 并 warn", () => {
		const warnings: string[] = [];
		const handle = stubHandle();
		const tools = bridgeMcpTools(
			"my server!",
			[{ name: "greet", description: "", inputSchema: { type: "object" } }],
			handle,
			{ warn: (t) => warnings.push(t) },
		);
		expect(tools[0]?.name).toBe("mcp__my_server___greet");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"my server!"');
		expect(warnings[0]).toContain('"my_server_"');
	});

	it("缺 description 给空串；缺 inputSchema 仍产出 object 声明", () => {
		const handle = stubHandle();
		const tools = bridgeMcpTools("demo", [{ name: "ping" }], handle);
		expect(tools[0]?.description).toBe("");
		const registry = createToolRegistry();
		registry.register(tools[0] as (typeof tools)[number]);
		const [declaration] = registry.declarations();
		expect(declaration?.parameters.type).toBe("object");
	});

	it("顶层 schema 非 object（anyOf）时回退空对象：声明合规且入参原样放行", async () => {
		const handle = stubHandle();
		const tools = bridgeMcpTools(
			"demo",
			[
				{
					name: "flex",
					description: "",
					inputSchema: { anyOf: [{ type: "string" }, { type: "number" }] },
				},
			],
			handle,
		);
		const registry = createToolRegistry();
		registry.register(tools[0] as (typeof tools)[number]);
		expect(registry.declarations()[0]?.parameters.type).toBe("object");
		// 不拦：任意入参（含对象）parse 后原样到达 callTool（passthrough 不丢键）
		const output = await tools[0]?.execute({ weird: [1, 2] }, makeCtx());
		expect(handle.calls[0]?.args).toEqual({ weird: [1, 2] });
		expect(output?.isError).not.toBe(true);
	});

	it("空名工具跳过不桥接", () => {
		const handle = stubHandle();
		const tools = bridgeMcpTools(
			"demo",
			[{ name: "  ", description: "" }],
			handle,
		);
		expect(tools).toHaveLength(0);
	});
});

describe("桥接工具 execute", () => {
	it("callTool 收原始工具名 + 入参，content text 块以换行拼接", async () => {
		const handle = stubHandle({
			callTool: async () => ({
				content: [
					{ type: "text", text: "line1" },
					{ type: "image", data: "AAA", mimeType: "image/png" },
					{ type: "text", text: "line2" },
					{ type: "resource", resource: { uri: "file:///a.txt", text: "x" } },
				],
			}),
		});
		const tools = bridgeMcpTools(
			"demo",
			[
				{
					name: "greet",
					description: "",
					inputSchema: { type: "object" },
				},
			],
			handle,
		);
		const output = await tools[0]?.execute({ who: "bob" }, makeCtx());
		expect(handle.calls).toEqual([{ name: "greet", args: { who: "bob" } }]);
		expect(output?.content).toBe(
			"line1\n[image: image/png]\nline2\n[resource: file:///a.txt]",
		);
		expect(output?.isError).not.toBe(true);
	});

	it("MCP isError=true 透传为 ToolOutput.isError", async () => {
		const handle = stubHandle({
			callTool: async () => ({
				content: [{ type: "text", text: "boom" }],
				isError: true,
			}),
		});
		const tools = bridgeMcpTools(
			"demo",
			[{ name: "fail", description: "", inputSchema: { type: "object" } }],
			handle,
		);
		const output = await tools[0]?.execute({}, makeCtx());
		expect(output?.isError).toBe(true);
		expect(output?.content).toBe("boom");
	});

	it("callTool 抛错映射 isError，消息含桥接工具名", async () => {
		const handle = stubHandle({
			callTool: async () => {
				throw new Error("connection lost");
			},
		});
		const tools = bridgeMcpTools(
			"demo",
			[{ name: "x", description: "", inputSchema: { type: "object" } }],
			handle,
		);
		const output = await tools[0]?.execute({}, makeCtx());
		expect(output?.isError).toBe(true);
		expect(output?.content).toContain("mcp__demo__x");
		expect(output?.content).toContain("connection lost");
	});

	it("60s 硬超时路径：慢调用被 AbortSignal.timeout 中断并映射 isError", async () => {
		// stub 模拟 SDK 行为：信号触发即拒绝（AbortSignal.timeout 的 reason 是 TimeoutError）
		const handle = stubHandle({
			callTool: async (_name, _args, callOpts) => {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 2_000);
					callOpts.signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(callOpts.signal.reason);
						},
						{ once: true },
					);
				});
				return { content: [{ type: "text", text: "late" }] };
			},
		});
		const tools = bridgeMcpTools(
			"demo",
			[{ name: "slow", description: "", inputSchema: { type: "object" } }],
			handle,
			{ toolTimeoutMs: 30 },
		);
		const output = await tools[0]?.execute({}, makeCtx());
		expect(output?.isError).toBe(true);
		expect(output?.content).toContain("timed out after 30 ms");
	});

	it("ctx.signal 中止映射 isError，且透传给 callTool 的信号已置 abort", async () => {
		const handle = stubHandle({
			callTool: async (_name, _args, callOpts) => {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 2_000);
					callOpts.signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new DOMException("aborted", "AbortError"));
						},
						{ once: true },
					);
				});
				return { content: [] };
			},
		});
		const tools = bridgeMcpTools(
			"demo",
			[{ name: "x", description: "", inputSchema: { type: "object" } }],
			handle,
		);
		const ac = new AbortController();
		const promise = tools[0]?.execute({}, makeCtx(ac.signal));
		ac.abort();
		const output = await promise;
		expect(handle.signals[0]?.aborted).toBe(true);
		expect(output?.isError).toBe(true);
		expect(output?.content).toContain("aborted");
	});

	it("无 content 块时 content 为空串（不报错）", async () => {
		const handle = stubHandle({ callTool: async () => ({}) });
		const tools = bridgeMcpTools(
			"demo",
			[{ name: "x", description: "", inputSchema: { type: "object" } }],
			handle,
		);
		const output = await tools[0]?.execute({}, makeCtx());
		expect(output?.content).toBe("");
		expect(output?.isError).not.toBe(true);
	});
});

// ---- 连接 ----

describe("connectMcpServers 逐 server 隔离", () => {
	const STDIO_CONFIG = {
		command: "node",
		args: ["server.js"],
		env: { FOO: "bar" },
	};
	const HTTP_CONFIG = {
		url: "https://mcp.example.com/mcp",
		headers: { authorization: "Bearer t" },
	};

	it("stdio/http 按配置键分类，配置原样传给工厂", async () => {
		const seen: { name: string; config: unknown; cwd: string }[] = [];
		const factory = async (
			name: string,
			config: { command?: string; url?: string },
			opts: { cwd: string; signal: AbortSignal },
		) => {
			seen.push({ name, config, cwd: opts.cwd });
			return stubHandle({ tools: [{ name: `t-${name}` }] });
		};
		const connections = await connectMcpServers(
			{ local: STDIO_CONFIG, remote: HTTP_CONFIG },
			{ cwd: "/work", createClient: factory },
		);
		expect(connections.map((c) => c.transport).sort()).toEqual([
			"http",
			"stdio",
		]);
		expect(seen.find((s) => s.name === "local")?.config).toEqual(STDIO_CONFIG);
		expect(seen.find((s) => s.name === "remote")?.config).toEqual(HTTP_CONFIG);
		expect(seen[0]?.cwd).toBe("/work");
		const local = connections.find((c) => c.name === "local");
		expect(local?.tools[0]?.name).toBe("mcp__local__t-local");
	});

	it("失败 server warn + 跳过，不阻塞其余装配", async () => {
		const warnings: string[] = [];
		const factory = async (name: string) => {
			if (name === "bad") {
				throw new Error("spawn failed");
			}
			return stubHandle({ tools: [{ name: "up" }] });
		};
		const connections = await connectMcpServers(
			{ bad: STDIO_CONFIG, good: STDIO_CONFIG },
			{ cwd: "/work", warn: (t) => warnings.push(t), createClient: factory },
		);
		expect(connections.map((c) => c.name)).toEqual(["good"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"bad"');
		expect(warnings[0]).toContain("stdio");
		expect(warnings[0]).toContain("spawn failed");
	});

	it("listTools 失败视同连接失败：关闭句柄防泄漏并跳过", async () => {
		const warnings: string[] = [];
		let closed = 0;
		const factory = async (): Promise<McpClientHandle> => ({
			async listTools() {
				throw new Error("listTools boom");
			},
			async callTool() {
				return {};
			},
			async close() {
				closed += 1;
			},
		});
		const connections = await connectMcpServers(
			{ flaky: STDIO_CONFIG },
			{ cwd: "/work", warn: (t) => warnings.push(t), createClient: factory },
		);
		expect(connections).toHaveLength(0);
		expect(closed).toBe(1);
		expect(warnings[0]).toContain("listTools boom");
	});

	it("连接超时（timeoutMs）经 signal 生效：悬置 connect 被跳过", async () => {
		const factory = (
			_name: string,
			_config: unknown,
			opts: { cwd: string; signal: AbortSignal },
		): Promise<McpClientHandle> =>
			new Promise((_, reject) => {
				opts.signal.addEventListener(
					"abort",
					() => reject(new Error("connect timed out")),
					{ once: true },
				);
			});
		const warnings: string[] = [];
		const connections = await connectMcpServers(
			{ slow: STDIO_CONFIG },
			{
				cwd: "/work",
				timeoutMs: 30,
				warn: (t) => warnings.push(t),
				createClient: factory,
			},
		);
		expect(connections).toHaveLength(0);
		expect(warnings[0]).toContain("connect timed out");
	});

	it("零工具 server 也保留连接（attach 成功但无桥接工具）", async () => {
		const connections = await connectMcpServers(
			{ empty: STDIO_CONFIG },
			{ cwd: "/work", createClient: async () => stubHandle({ tools: [] }) },
		);
		expect(connections).toHaveLength(1);
		expect(connections[0]?.tools).toEqual([]);
	});
});

describe("closeMcpConnections", () => {
	it("关闭全部连接；单个 close 抛错不拖垮其余", async () => {
		const good = stubHandle();
		const bad: McpConnection = {
			name: "bad",
			transport: "http",
			client: {
				async listTools() {
					return [];
				},
				async callTool() {
					return {};
				},
				async close() {
					throw new Error("close boom");
				},
			},
			tools: [],
		};
		const goodConn: McpConnection = {
			name: "good",
			transport: "stdio",
			client: good,
			tools: [],
		};
		await expect(closeMcpConnections([bad, goodConn])).resolves.toBeUndefined();
		expect(good.closeCalls).toBe(1);
	});
});
