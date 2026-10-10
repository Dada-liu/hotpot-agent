import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.ts";

// 每个用例一个临时 home，settings.json 写在 <home>/settings.json
let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-config-test-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

// 全字段合法 settings；apiKey 用字面值（不触发 $ENV 插值）
function validSettings(): unknown {
	return {
		models: {
			high: {
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				apiKey: "sk-ant-literal",
			},
			medium: {
				provider: "openai",
				model: "gpt-4.1",
				apiKey: "sk-oai-literal",
				baseUrl: "https://api.openai.com",
			},
			low: {
				provider: "deepseek",
				model: "deepseek-chat",
				apiKey: "sk-ds-literal",
			},
		},
		mainAgentTier: "medium",
		maxParallelTasks: 4,
		planMaxRevisions: 2,
		approval: { policy: "ask-on-dangerous" },
	};
}

async function writeSettings(data: unknown): Promise<void> {
	await writeFile(join(home, "settings.json"), JSON.stringify(data));
}

describe("loadSettings", () => {
	it("解析全字段合法 settings，值原样保留", async () => {
		await writeSettings(validSettings());
		const settings = loadSettings(home);
		expect(settings).toEqual(validSettings());
	});

	it("只给 models 三档即可，可选字段为 undefined", async () => {
		const minimal = {
			models: {
				high: { provider: "anthropic", model: "m1", apiKey: "k1" },
				medium: { provider: "openai", model: "m2", apiKey: "k2" },
				low: { provider: "deepseek", model: "m3", apiKey: "k3" },
			},
		};
		await writeSettings(minimal);
		const settings = loadSettings(home);
		expect(settings.models.high.provider).toBe("anthropic");
		expect(settings.mainAgentTier).toBeUndefined();
		expect(settings.maxParallelTasks).toBeUndefined();
		expect(settings.planMaxRevisions).toBeUndefined();
		expect(settings.approval).toBeUndefined();
	});

	it("缺档位报错：models 少 medium 时抛出含 medium 的错误", async () => {
		const data = validSettings() as { models: Record<string, unknown> };
		delete data.models.medium;
		await writeSettings(data);
		expect(() => loadSettings(home)).toThrow(/medium/);
	});

	it("apiKey 的 $ENV 引用插值为环境变量的值", async () => {
		const data = validSettings() as {
			models: { high: { apiKey: string } };
		};
		data.models.high.apiKey = "$HOTPOT_TEST_API_KEY";
		await writeSettings(data);
		process.env.HOTPOT_TEST_API_KEY = "sk-from-env";
		try {
			const settings = loadSettings(home);
			expect(settings.models.high.apiKey).toBe("sk-from-env");
			// 字面 apiKey 不插值
			expect(settings.models.low.apiKey).toBe("sk-ds-literal");
		} finally {
			delete process.env.HOTPOT_TEST_API_KEY;
		}
	});

	it("Review Focus 4：$ENV 变量未设置时报错，错误含变量名", async () => {
		const data = validSettings() as {
			models: { low: { apiKey: string } };
		};
		data.models.low.apiKey = "$HOTPOT_TEST_UNSET_KEY";
		await writeSettings(data);
		delete process.env.HOTPOT_TEST_UNSET_KEY;
		expect(() => loadSettings(home)).toThrow(/HOTPOT_TEST_UNSET_KEY/);
	});

	it("settings.json 不存在时报错，错误含文件路径", () => {
		expect(() => loadSettings(home)).toThrow(/settings\.json/);
	});

	it("非法 JSON 报错，错误含文件路径", async () => {
		await writeFile(join(home, "settings.json"), "{not json");
		expect(() => loadSettings(home)).toThrow(/settings\.json/);
	});

	it("home 缺省时读 HOTPOT_HOME 环境变量", async () => {
		await writeSettings(validSettings());
		const oldEnv = process.env.HOTPOT_HOME;
		process.env.HOTPOT_HOME = home;
		try {
			const settings = loadSettings();
			expect(settings.models.high.model).toBe("claude-sonnet-4-5");
		} finally {
			if (oldEnv === undefined) {
				delete process.env.HOTPOT_HOME;
			} else {
				process.env.HOTPOT_HOME = oldEnv;
			}
		}
	});
});
