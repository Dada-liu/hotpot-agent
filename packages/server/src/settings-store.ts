// 用户级 settings.json 的全量读写（web 设置弹窗用）。
// 与 loadSettings 的差异：不做 $ENV 插值，敏感字段（models.*.apiKey、
// webSearch.apiKey、telemetry.token）只返回固定掩码；其余字段经 schema
// 解析后整体写回，未知键原样保留（parse → 写回）。PUT 中仍为掩码的字段
// 保留磁盘原值，其他非空值表示明确替换。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome, settingsSchema } from "@hotpot/core";
import type { z } from "zod";

// 暴露给 web 的用户级设置视图；PUT body 同形
const settingsViewSchema = settingsSchema;
export type SettingsView = z.infer<typeof settingsViewSchema>;
export const putSettingsSchema = settingsViewSchema;

function settingsPath(home?: string): string {
	return join(resolveHome(home), "settings.json");
}

// 原始 JSON 必须是对象（数组/标量无法按键合并）
function readRawSettings(path: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new Error(`settings file not found or unreadable: ${path}`);
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`settings file is not valid JSON: ${path}`);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`settings file ${path} must contain a JSON object`);
	}
	return data as Record<string, unknown>;
}

export const API_KEY_MASK = "********";

// 解析失败时统一的带路径错误（路由转 500）
function parseSettingsOrThrow(path: string, raw: Record<string, unknown>) {
	const parsed = settingsViewSchema.safeParse(raw);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`invalid settings in ${path}: ${detail}`);
	}
	return parsed.data;
}

// 读用户级设置全量视图；文件缺失/非法 JSON/不合规统一抛带路径的错误（路由转 500）
export function readUserSettings(home?: string): SettingsView {
	const path = settingsPath(home);
	const parsed = parseSettingsOrThrow(path, readRawSettings(path));
	for (const tier of ["high", "medium", "low"] as const) {
		parsed.models[tier].apiKey = API_KEY_MASK;
	}
	if (parsed.webSearch?.apiKey !== undefined) {
		parsed.webSearch = { ...parsed.webSearch, apiKey: API_KEY_MASK };
	}
	if (parsed.telemetry?.token !== undefined) {
		parsed.telemetry = { ...parsed.telemetry, token: API_KEY_MASK };
	}
	return parsed;
}

// 写回：视图键整体覆盖，掩码字段保留磁盘原值，未知键保持原值
export function writeUserSettings(settings: SettingsView, home?: string): void {
	const path = settingsPath(home);
	const raw = readRawSettings(path);
	const current = parseSettingsOrThrow(path, raw);
	for (const tier of ["high", "medium", "low"] as const) {
		if (settings.models[tier].apiKey === API_KEY_MASK) {
			settings.models[tier].apiKey = current.models[tier].apiKey;
		}
	}
	if (settings.webSearch?.apiKey === API_KEY_MASK && current.webSearch) {
		settings.webSearch = {
			...settings.webSearch,
			apiKey: current.webSearch.apiKey,
		};
	}
	if (settings.telemetry?.token === API_KEY_MASK && current.telemetry) {
		settings.telemetry = {
			...settings.telemetry,
			token: current.telemetry.token,
		};
	}
	writeFileSync(
		path,
		`${JSON.stringify({ ...raw, ...settings }, null, 2)}\n`,
		"utf8",
	);
}
