// SWE-bench 实例切片：读取 export_instances.py 导出的 JSONL，做确定性选择。
// 字段与官方数据集一致；FAIL_TO_PASS / PASS_TO_PASS 统一为字符串数组。
// 选择规则：显式 instanceIds 优先（按请求顺序，未知 id 直接报错）；
// 否则用 mulberry32 + Fisher-Yates 按 seed 洗牌，再截取 limit。
// 默认 seed 固定，保证同一份实例文件每次跑批得到同一子集。

import { readFile } from "node:fs/promises";
import { z } from "zod";

const instanceSchema = z.object({
	instance_id: z.string().min(1),
	repo: z.string().min(1),
	base_commit: z.string().min(1),
	problem_statement: z.string(),
	FAIL_TO_PASS: z.array(z.string()),
	PASS_TO_PASS: z.array(z.string()),
	version: z.string(),
});

export type SwebenchInstance = z.infer<typeof instanceSchema>;

export interface SelectInstancesOptions {
	limit?: number;
	instanceIds?: string[];
	// 缺省 0：同一个实例文件与 limit 得到稳定子集
	seed?: number;
}

export async function loadInstances(file: string): Promise<SwebenchInstance[]> {
	const text = await readFile(file, "utf8");
	const instances: SwebenchInstance[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim() === "") {
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch {
			throw new Error(`${file}:${index + 1}: invalid JSON`);
		}
		const parsed = instanceSchema.safeParse(value);
		if (!parsed.success) {
			const detail = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			throw new Error(`${file}:${index + 1}: invalid instance: ${detail}`);
		}
		instances.push(parsed.data);
	}
	if (instances.length === 0) {
		throw new Error(`no instances found in ${file}`);
	}
	return instances;
}

export function selectInstances(
	instances: SwebenchInstance[],
	opts: SelectInstancesOptions = {},
): SwebenchInstance[] {
	const limit = opts.limit;
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
		throw new Error(`limit must be a non-negative integer, got ${limit}`);
	}

	if (opts.instanceIds !== undefined) {
		const byId = new Map(
			instances.map((instance) => [instance.instance_id, instance]),
		);
		const missing = opts.instanceIds.filter((id) => !byId.has(id));
		if (missing.length > 0) {
			throw new Error(`unknown instance id(s): ${missing.join(", ")}`);
		}
		const selected: SwebenchInstance[] = [];
		for (const id of opts.instanceIds) {
			const instance = byId.get(id);
			if (instance !== undefined) {
				selected.push(instance);
			}
		}
		return limit === undefined ? selected : selected.slice(0, limit);
	}

	const shuffled = [...instances];
	const random = mulberry32(opts.seed ?? 0);
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(random() * (index + 1));
		const current = shuffled[index];
		const other = shuffled[swapIndex];
		if (current === undefined || other === undefined) {
			continue;
		}
		shuffled[index] = other;
		shuffled[swapIndex] = current;
	}
	return limit === undefined ? shuffled : shuffled.slice(0, limit);
}

// mulberry32：小而确定的 32 位 PRNG，足够做可复现抽样，不引入依赖
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}
