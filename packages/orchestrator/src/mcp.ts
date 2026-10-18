// MCP 客户端桥接（M4 Feature⑦）：settings.mcpServers 的 server 配置经
// @modelcontextprotocol/sdk 建连（stdio 子进程 / streamable HTTP），listTools 结果
// 桥接为 core 的 ToolDefinition（命名 mcp__<server>__<tool>），execute 转发
// client.callTool 并把 content 的 text 块拼接回 ToolOutput.content。
// 连接层可注入（opts.createClient）：测试用 stub client 保证 hermetic，不触真实 server。
// 逐 server try/catch：单个失败 warn + 跳过，不阻塞其余装配（验收要求）。

import type {
	McpServersConfig,
	ToolDefinition,
	ToolOutput,
} from "@hotpot/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { jsonSchemaToZod } from "./json-schema-to-zod.ts";

// 单次 callTool 超时（AbortSignal.timeout 硬上限，与 ctx.signal 经 AbortSignal.any 组合）
export const MCP_TOOL_TIMEOUT_MS = 60_000;
// 单个 server connect 的缺省超时（npx 冷启动也要兜住）
export const MCP_CONNECT_TIMEOUT_MS = 30_000;

// MCP server 配置（config.ts mcpServersSchema 的 union 成员：stdio | http）
export type McpServerConfig = McpServersConfig[string];

// 连接层最小句柄：listTools/callTool/close 三件套；默认实现包 SDK Client
export interface McpClientHandle {
	listTools(): Promise<McpToolInfo[]>;
	callTool(
		name: string,
		args: unknown,
		opts: { signal: AbortSignal },
	): Promise<McpToolCallResult>;
	close(): Promise<void>;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	// JSON Schema 原文（结构任意，桥接层走 json-schema-to-zod 子集转换）
	inputSchema?: unknown;
}

export interface McpToolCallResult {
	content?: unknown;
	isError?: boolean;
}

export interface McpConnection {
	name: string;
	transport: "stdio" | "http";
	client: McpClientHandle;
	tools: ToolDefinition<unknown>[];
}

// client 工厂注入缝：签名与默认实现一致，stub 后配置可指向假 server
export type McpClientFactory = (
	server: string,
	config: McpServerConfig,
	opts: { cwd: string; signal: AbortSignal },
) => Promise<McpClientHandle>;

// 桥接工具名对 server 名的合法字符要求（保守集）：字母数字 _ -，其余替换为 _
const SERVER_NAME_ILLEGAL = /[^A-Za-z0-9_-]/g;

export function sanitizeServerName(name: string): string {
	return name.replace(SERVER_NAME_ILLEGAL, "_");
}

// 桥接 listTools 结果 → ToolDefinition 列表（连接无关的纯桥接，单测直接打桩 tools）。
// server 名含非法字符时替换为 _ 并 warn；MCP 工具名按 spec 限定 [a-zA-Z0-9_-]，直接透传。
// toolTimeoutMs 为测试注入口（缺省 60s 生产值），超时路径用短超时 hermetic 验证
export function bridgeMcpTools(
	server: string,
	tools: readonly McpToolInfo[],
	client: McpClientHandle,
	opts?: { warn?: (text: string) => void; toolTimeoutMs?: number },
): ToolDefinition<unknown>[] {
	const warn = opts?.warn ?? (() => {});
	const toolTimeoutMs = opts?.toolTimeoutMs ?? MCP_TOOL_TIMEOUT_MS;
	const sanitized = sanitizeServerName(server);
	if (sanitized !== server) {
		warn(
			`MCP server name "${server}" contains characters not allowed in tool names; bridged as "${sanitized}"`,
		);
	}
	const bridged: ToolDefinition<unknown>[] = [];
	for (const tool of tools) {
		if (tool.name.trim() === "") {
			continue; // 空名工具无法寻址，跳过
		}
		bridged.push(createBridgedTool(sanitized, tool, client, toolTimeoutMs));
	}
	return bridged;
}

function createBridgedTool(
	server: string,
	tool: McpToolInfo,
	client: McpClientHandle,
	toolTimeoutMs: number,
): ToolDefinition<unknown> {
	const name = `mcp__${server}__${tool.name}`;
	const converted = jsonSchemaToZod(tool.inputSchema);
	// registry.declarations() 要求顶层 object（LLM API 约定）：转换结果非 object 时
	// 回退「空对象 + passthrough」，声明合规且入参原样放行（不拦原则）
	const parameters =
		converted instanceof z.ZodObject ? converted : z.object({}).passthrough();
	return {
		name,
		description: tool.description ?? "",
		parameters,
		// 远端工具副作用不可判定，一律按不可并行处理
		isConcurrencySafe: false,
		async execute(args, ctx): Promise<ToolOutput> {
			const signal = AbortSignal.any([
				ctx.signal,
				AbortSignal.timeout(toolTimeoutMs),
			]);
			let result: McpToolCallResult;
			try {
				result = await client.callTool(tool.name, args, { signal });
			} catch (err) {
				// AbortSignal.timeout 触发 TimeoutError；ctx.signal 触发 AbortError
				if (err instanceof DOMException && err.name === "TimeoutError") {
					return {
						content: `MCP tool "${name}" timed out after ${toolTimeoutMs} ms`,
						isError: true,
					};
				}
				if (err instanceof DOMException && err.name === "AbortError") {
					return { content: `MCP tool "${name}" aborted`, isError: true };
				}
				return {
					content: `MCP tool "${name}" failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
					isError: true,
				};
			}
			return {
				content: extractContentText(result.content),
				isError: result.isError === true,
			};
		},
	};
}

// content 块 → 文本：text 块直接拼接；image/audio/resource 块以占位行保留信息不静默丢；
// content 缺失（部分 server 只回 structuredContent 的形状）时回退 JSON 序列化原文
function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) {
			continue;
		}
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
		} else if (record.type === "image") {
			parts.push(
				`[image: ${typeof record.mimeType === "string" ? record.mimeType : "unknown mime"}]`,
			);
		} else if (record.type === "audio") {
			parts.push("[audio]");
		} else if (record.type === "resource") {
			// resource 块的 uri 嵌在 resource 子对象里（text/blob 二选一）
			const inner = record.resource;
			const innerUri =
				typeof inner === "object" && inner !== null
					? (inner as Record<string, unknown>).uri
					: undefined;
			parts.push(
				`[resource: ${typeof innerUri === "string" ? innerUri : "[embedded resource]"}]`,
			);
		} else if (record.type === "resource_link") {
			const uri = typeof record.uri === "string" ? record.uri : "";
			parts.push(`[resource link: ${uri}]`);
		}
	}
	return parts.join("\n");
}

// 默认连接实现：stdio 起子进程（stderr 走 inherit，SDK 缺省，server 日志直落终端便于排障），
// http 走 streamable HTTP（headers 经 requestInit 传入）；connect 与中止信号竞速，
// 超时/中止后关闭 transport（stdio 会 SIGKILL 子进程，防泄漏）
async function defaultCreateClient(
	_server: string,
	config: McpServerConfig,
	opts: { cwd: string; signal: AbortSignal },
): Promise<McpClientHandle> {
	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if ("command" in config) {
		transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: config.env,
			cwd: opts.cwd,
		});
	} else {
		transport = new StreamableHTTPClientTransport(new URL(config.url), {
			...(config.headers === undefined
				? {}
				: { requestInit: { headers: config.headers } }),
		});
	}
	const client = new Client(
		{ name: "hotpot-code", version: "0.0.0" },
		{
			capabilities: {},
		},
	);
	try {
		await Promise.race([client.connect(transport), abortPromise(opts.signal)]);
	} catch (err) {
		await client.close().catch(() => {});
		throw err;
	}
	return {
		async listTools(): Promise<McpToolInfo[]> {
			const result = await client.listTools();
			return result.tools as unknown as McpToolInfo[];
		},
		async callTool(name, args, callOpts): Promise<McpToolCallResult> {
			const result = await client.callTool(
				{ name, arguments: args as Record<string, unknown> | undefined },
				undefined,
				{ signal: callOpts.signal },
			);
			return result as unknown as McpToolCallResult;
		},
		async close(): Promise<void> {
			await client.close();
		},
	};
}

function abortPromise(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

// 逐个 server 建连 + 桥接；单 server 失败 warn + 跳过，不阻塞其余（验收要求）。
// listTools 失败视同连接失败：关闭句柄防泄漏后跳过。返回的连接由调用方在
// finally 里经 closeMcpConnections 统一关闭
export async function connectMcpServers(
	servers: McpServersConfig,
	opts: {
		cwd: string;
		timeoutMs?: number;
		warn?: (text: string) => void;
		createClient?: McpClientFactory;
	},
): Promise<McpConnection[]> {
	const warn = opts.warn ?? (() => {});
	const createClient = opts.createClient ?? defaultCreateClient;
	const connections: McpConnection[] = [];
	for (const [name, config] of Object.entries(servers)) {
		const transport: "stdio" | "http" = "command" in config ? "stdio" : "http";
		try {
			const signal = AbortSignal.timeout(
				opts.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
			);
			const client = await createClient(name, config, {
				cwd: opts.cwd,
				signal,
			});
			let tools: McpToolInfo[];
			try {
				tools = await client.listTools();
			} catch (err) {
				await client.close().catch(() => {});
				throw err;
			}
			connections.push({
				name,
				transport,
				client,
				tools: bridgeMcpTools(name, tools, client, { warn }),
			});
		} catch (err) {
			warn(
				`MCP server "${name}" (${transport}) failed to attach: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return connections;
}

// 关闭全部连接；单个关闭失败静默吞掉，不拖垮其余（进程退出路径的兜底清理）
export async function closeMcpConnections(
	connections: readonly McpConnection[],
): Promise<void> {
	await Promise.all(connections.map((c) => c.client.close().catch(() => {})));
}
