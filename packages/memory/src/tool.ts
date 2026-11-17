import { z } from "zod";
import type { CodeIndexService, CodeSearchResult } from "./types.ts";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_EXCERPT_CHARS = 800;

type CodeSearchArgs = { query: string; limit?: number };

export interface CodeSearchTool {
	name: string;
	description: string;
	parameters: z.ZodType<CodeSearchArgs>;
	isConcurrencySafe: false;
	execute(
		args: CodeSearchArgs,
		ctx: { signal: AbortSignal; [key: string]: unknown },
	): Promise<{
		content: string;
		details: { results: CodeSearchResult[] };
		isError?: boolean;
	}>;
}

function boundedResult(result: CodeSearchResult): CodeSearchResult {
	return {
		...result,
		excerpt:
			result.excerpt.length <= MAX_EXCERPT_CHARS
				? result.excerpt
				: `${result.excerpt.slice(0, MAX_EXCERPT_CHARS - 1)}…`,
	};
}

export function createCodeSearchTool(
	service: CodeIndexService,
): CodeSearchTool {
	return {
		name: "code_search",
		description:
			"Search the current workspace using local incremental code indexing and embeddings. Returns relative paths, line ranges, similarity scores and bounded source excerpts. Only source files are indexed: documentation (.md/.txt) and config files (.json/.yaml) are skipped, so use read/grep for those. The index refreshes only when this tool is called.",
		parameters: z.object({
			query: z.string().min(1).describe("natural-language code search query"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(MAX_LIMIT)
				.optional()
				.describe("maximum results; default 5, maximum 20"),
		}),
		isConcurrencySafe: false,
		async execute(args, ctx) {
			const results = (
				await service.search(
					args.query,
					args.limit ?? DEFAULT_LIMIT,
					ctx.signal,
				)
			)
				.map(boundedResult)
				.sort((left, right) => right.score - left.score);
			const index = service.stats();
			if (results.length === 0) {
				// 空索引与「有索引但没匹配」是两回事：前者多半是工作区里没有可索引的
				// 源码文件（例如只有 Markdown 文档），必须说清楚，否则模型会误判目录为空
				return {
					content:
						index.files === 0
							? "No indexable source files in this workspace. code_search only indexes source files (.ts/.tsx/.js/.py/.go/.rs/.java/.sh/.sql and similar); documentation and config files such as .md, .txt, .json, .yaml are skipped. Use read / grep / glob instead."
							: `No matching code found in the ${index.files} indexed files (${index.chunks} chunks). Try different wording or a broader query.`,
					details: { results, index },
				};
			}
			return {
				content: JSON.stringify(results, null, 2),
				details: { results },
			};
		},
	};
}
