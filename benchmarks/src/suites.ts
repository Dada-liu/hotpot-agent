// 评测套件：固定题目清单，默认 lite10。
// 为什么不用 --limit 10：limit 是在「实例文件的行序 + seed」上洗牌再截取，
// 换一份导出文件（哪怕题集相同）就会抽到不同的题，两次跑批无法按题配对。
// 套件把 id 清单变成数据，题集哈希只取决于这 10 个 id。
//
// 套件只描述「跑哪些题」，不描述「怎么跑」：模型档位、运行档、重复次数仍由 CLI 与 manifest 记录。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const suiteSchema = z
	.object({
		name: z.string().min(1),
		title: z.string().min(1),
		note: z.string().min(1),
		dataset: z.string().min(1),
		split: z.string().min(1),
		instanceIds: z.array(z.string().min(1)).min(1),
	})
	.strict();

export type BenchSuite = z.infer<typeof suiteSchema>;

export const DEFAULT_SUITE_NAME = "lite10";

const cache = new Map<string, BenchSuite>();

// 套件目录随包提交，路径按 import.meta.url 解析：源码直跑（tsx）与打包后都能找到。
export async function loadBenchSuite(
	name: string = DEFAULT_SUITE_NAME,
): Promise<BenchSuite> {
	const cached = cache.get(name);
	if (cached !== undefined) {
		return cached;
	}
	if (!/^[a-z][a-z0-9-]*$/.test(name)) {
		throw new Error(`invalid suite name: ${name}`);
	}
	const path = fileURLToPath(
		new URL(`../suites/${name}.json`, import.meta.url),
	);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new Error(`bench suite not found: ${name} (${path})`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${path}: invalid JSON`);
	}
	const parsed = suiteSchema.safeParse(value);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`${path}: invalid suite: ${detail}`);
	}
	const duplicates = duplicatesOf(parsed.data.instanceIds);
	if (duplicates.length > 0) {
		// 重复 id 会让同一题被跑两次并计两次，passRate 直接失真
		throw new Error(
			`${path}: duplicate instance id(s): ${duplicates.join(", ")}`,
		);
	}
	cache.set(name, parsed.data);
	return parsed.data;
}

function duplicatesOf(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			duplicates.add(value);
		}
		seen.add(value);
	}
	return [...duplicates];
}
