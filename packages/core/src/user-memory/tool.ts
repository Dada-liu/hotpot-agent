// memory_save：唯一的用户记忆写工具；正文只进 MEMORY.md，会话仅落审计元数据

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition } from "../tools/tool.ts";
import { appendMemory } from "./memory.ts";

type MemorySaveArgs = { content: string };

export function createMemorySaveTool(
	home?: string,
): ToolDefinition<MemorySaveArgs> {
	return {
		name: "memory_save",
		description:
			"Save a stable user preference or fact to the user-level MEMORY.md file. Do not save secrets, credentials, or temporary task state.",
		parameters: z.object({
			content: z
				.string()
				.min(1)
				.describe("the stable preference or fact to append to user memory"),
		}),
		isConcurrencySafe: false,
		async execute(args, ctx) {
			try {
				await appendMemory(args.content, home);
				await ctx.session.append({
					type: "memory/saved",
					id: randomUUID(),
					ts: new Date().toISOString(),
					agentId: ctx.agentId,
				});
				return { content: "Memory saved." };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: `Failed to save memory: ${message}`,
					isError: true,
				};
			}
		},
	};
}
