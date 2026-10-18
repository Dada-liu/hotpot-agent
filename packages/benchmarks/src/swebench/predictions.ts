// 官方预测格式：每行一个 JSON 对象，键固定为
// instance_id / model_name_or_path / model_patch（model_name_or_path 恒为 hotpot-code）。
// 空 patch 也写一行空字符串：官方 harness 会把它计入 empty_patch / unresolved，
// 而不是让 runner 静默丢掉该题（丢掉会让 report 题数对不上）。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MODEL_NAME = "hotpot-code";

export interface PredictionEntry {
	instanceId: string;
	patch: string;
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
