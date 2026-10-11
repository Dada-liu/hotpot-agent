// 工具注册表：register 把 ToolDefinition<T> 擦除为 ToolDefinition<unknown>，
// 擦除时用 schema.parse 包裹 execute/present，保证 LLM 传入的 unknown 入参先校验再执行；
// declarations 用 zod v4 内置的 z.toJSONSchema 产出 JSON Schema（不引 zod-to-json-schema）。

import type { ToolDeclaration } from "@hotpot/ai";
import { z } from "zod";
import type { ToolDefinition } from "./tool.ts";

export interface ToolRegistry {
	register<T>(tool: ToolDefinition<T>): void;
	declarations(): ToolDeclaration[];
	get(name: string): ToolDefinition<unknown> | undefined;
}

export function createToolRegistry(): ToolRegistry {
	const tools = new Map<string, ToolDefinition<unknown>>();

	return {
		register<T>(tool: ToolDefinition<T>): void {
			const present = tool.present;
			const erased: ToolDefinition<unknown> = {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				timeoutMs: tool.timeoutMs,
				isConcurrencySafe: tool.isConcurrencySafe,
				// async 包裹让 parse 抛出的 ZodError 成为 rejected promise 而非同步抛出
				execute: async (args, ctx) =>
					tool.execute(tool.parameters.parse(args), ctx),
				render: tool.render,
				present: present
					? (args, o) => present(tool.parameters.parse(args), o)
					: undefined,
			};
			tools.set(tool.name, erased);
		},

		declarations(): ToolDeclaration[] {
			return [...tools.values()].map((tool) => {
				const schema = z.toJSONSchema(tool.parameters);
				// LLM API 要求参数为顶层 object；其余形状（如 z.string()）直接抛错，防止静默产出坏声明
				if (schema.type !== "object") {
					throw new Error(
						`tool "${tool.name}": parameters schema must produce a top-level object type`,
					);
				}
				return {
					name: tool.name,
					// description 以工具定义字段为准，schema 顶层的 describe 不覆盖它
					description: tool.description,
					parameters: schema,
				};
			});
		},

		get(name: string): ToolDefinition<unknown> | undefined {
			return tools.get(name);
		},
	};
}
