// settings.json 加载：zod 校验 + apiKey 的 $ENV 插值
// 文件位于 <home>/settings.json；home 解析规则与会话日志一致（参数 > HOTPOT_HOME > ~/hotpot-code），
// 直接复用 session/store.ts 的 resolveHome，避免两处规则漂移。
// $ENV 插值：apiKey 整串形如 "$NAME" 时取环境变量；未设置（或为空）直接抛错并带变量名——
// 静默传空 key 会把配置错误推迟成难以排查的远端 401（Review Focus 4）

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveHome } from "./session/store.ts";

const modelRefSchema = z.object({
	provider: z.string().min(1),
	model: z.string().min(1),
	apiKey: z.string().min(1),
	baseUrl: z.string().min(1).optional(),
});

const settingsSchema = z.object({
	models: z.object({
		high: modelRefSchema,
		medium: modelRefSchema,
		low: modelRefSchema,
	}),
	mainAgentTier: z.enum(["high", "medium", "low"]).optional(),
	maxParallelTasks: z.number().int().positive().optional(),
	planMaxRevisions: z.number().int().positive().optional(),
	approval: z
		.object({
			policy: z.enum(["ask-on-dangerous", "always", "never"]).optional(),
		})
		.optional(),
});

export type ModelRef = z.infer<typeof modelRefSchema>;
export type Settings = z.infer<typeof settingsSchema>;

// apiKey 的 $ENV 引用要求整串匹配，避免误伤字面值里恰好含 $ 的 key
const ENV_REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

function resolveApiKey(tier: string, apiKey: string, path: string): string {
	const match = ENV_REF_PATTERN.exec(apiKey);
	if (!match) {
		return apiKey;
	}
	const name = match[1];
	const value = name === undefined ? undefined : process.env[name];
	if (value === undefined || value === "") {
		throw new Error(
			`settings file ${path}: models.${tier}.apiKey references environment variable "$${name}", but it is not set`,
		);
	}
	return value;
}

// 同步读取 + 校验 + 插值；任何失败都抛出含文件路径与具体原因的错误
export function loadSettings(home?: string): Settings {
	const path = join(resolveHome(home), "settings.json");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new Error(`settings file not found or unreadable: ${path}`);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`settings file is not valid JSON: ${path}`);
	}
	const parsed = settingsSchema.safeParse(json);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`invalid settings in ${path}: ${detail}`);
	}
	const settings = parsed.data;
	for (const tier of ["high", "medium", "low"] as const) {
		settings.models[tier].apiKey = resolveApiKey(
			tier,
			settings.models[tier].apiKey,
			path,
		);
	}
	return settings;
}
