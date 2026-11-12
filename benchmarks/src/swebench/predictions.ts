// 官方预测格式：每行一个 JSON 对象，键固定为
// instance_id / model_name_or_path / model_patch（model_name_or_path 恒为 hotpot-agent）。
// 空 patch 也写一行空字符串：官方 harness 会把它计入 empty_patch / unresolved，
// 而不是让 runner 静默丢掉该题（丢掉会让 report 题数对不上）。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MODEL_NAME = "hotpot-agent";

// 单次跑批的旧文件名。重复尝试后每次尝试各写一个文件（见 predictionsFileName），
// 这个常量只用于读取旧目录，新代码不再写入它。
export const PREDICTIONS_FILE = "predictions.jsonl";

// 官方 harness 按 instance_id 建索引，同一个 predictions 文件里同一题只能出现一次。
// 所以 k 次尝试必须分成 k 个文件、分别评测，不能把它们写进同一个文件。
export function predictionsFileName(attempt: number): string {
	return `predictions-a${attempt}.jsonl`;
}

export interface PredictionEntry {
	instanceId: string;
	// 1-based 尝试序号；缺省按 1 处理
	attempt?: number;
	patch: string;
}

// resume 与 merge 要回读已有预测：空 patch 必须保留，
// 否则「跑过但没产出 diff」的题会在合并时被误当成「没跑过」。
export async function readPredictions(
	file: string,
): Promise<PredictionEntry[]> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return [];
	}
	const entries: PredictionEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch {
			throw new Error(`${file}: invalid JSON line in predictions`);
		}
		const record = value as {
			instance_id?: unknown;
			model_patch?: unknown;
		};
		if (typeof record.instance_id !== "string") {
			throw new Error(`${file}: prediction without instance_id`);
		}
		entries.push({
			instanceId: record.instance_id,
			patch: typeof record.model_patch === "string" ? record.model_patch : "",
		});
	}
	return entries;
}

export async function writePredictions(
	file: string,
	entries: PredictionEntry[],
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const lines = entries.map((entry) =>
		JSON.stringify({
			instance_id: entry.instanceId,
			model_name_or_path: MODEL_NAME,
			model_patch: entry.patch,
		}),
	);
	await writeFile(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}
