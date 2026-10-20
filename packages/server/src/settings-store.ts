// 用户级 settings.json 的「模型设置」读写（web 设置弹窗用）。
// 与 loadSettings 的差异：不做 $ENV 插值——编辑器要看到 "$OPENAI_API_KEY" 引用原文；
// 只暴露/写回 models 与 mainAgentTier 两个键，其余字段原样保留（parse → 改键 → 写回）。
// apiKey 经 localhost 原样返回：服务绑定 127.0.0.1，本机任意进程本就可读该文件。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelsSchema, resolveHome } from "@hotpot/core";
import { z } from "zod";

// 暴露给 web 的模型设置视图；PUT body 同形
const modelSettingsViewSchema = z.object({
	models: modelsSchema,
	mainAgentTier: z.enum(["high", "medium", "low"]).optional(),
});
export type ModelSettingsView = z.infer<typeof modelSettingsViewSchema>;
export const putModelSettingsSchema = modelSettingsViewSchema;

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

// 读模型设置切片；文件缺失/非法 JSON/切片不合规统一抛带路径的错误（路由转 500）
export function readModelSettings(home?: string): ModelSettingsView {
	const path = settingsPath(home);
	const parsed = modelSettingsViewSchema.safeParse(readRawSettings(path));
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`invalid model settings in ${path}: ${detail}`);
	}
	return parsed.data;
}

// 写回：只覆盖 models/mainAgentTier，其余键保持原值；2 空格缩进 + 末尾换行
export function writeModelSettings(
	settings: ModelSettingsView,
	home?: string,
): void {
	const path = settingsPath(home);
	const raw = readRawSettings(path);
	raw.models = settings.models;
	if (settings.mainAgentTier !== undefined) {
		raw.mainAgentTier = settings.mainAgentTier;
	}
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
