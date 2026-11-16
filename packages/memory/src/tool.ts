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
			"Search the current workspace using local incremental code indexing and embeddings. Returns relative paths, line ranges, similarity scores and bounded source excerpts. The index refreshes only when this tool is called.",
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
			if (results.length === 0) {
				return {
					content: "No matching code found.",
					details: { results },
				};
			}
			return {
				content: JSON.stringify(results, null, 2),
				details: { results },
			};
		},
	};
}
