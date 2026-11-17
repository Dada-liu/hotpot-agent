// settings-store 测试：用户级 settings.json 全量读写的掩码与合并语义。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	API_KEY_MASK,
	readUserSettings,
	writeUserSettings,
} from "../src/settings-store.ts";

let dir: string;
let settingsPath: string;

const diskSettings = {
	models: {
		high: { provider: "anthropic", model: "claude", apiKey: "secret-high" },
		medium: { provider: "deepseek", model: "ds", apiKey: "secret-medium" },
		low: { provider: "moonshot", model: "k", apiKey: "secret-low" },
	},
	mainAgentTier: "medium",
	maxParallelTasks: 6,
	planMaxRevisions: 2,
	permission: { mode: "ask-on-dangerous" },
	features: { memory: true, compaction: false },
	compaction: { triggerRatio: 0.7, keepRecentTokens: 15000 },
	hooks: {
		Stop: [{ matcher: "*", hooks: [{ type: "command", command: "notify" }] }],
	},
	webSearch: {
		backend: "custom",
		apiKey: "secret-search",
		baseUrl: "https://s.example",
	},
	mcpServers: { fs: { command: "mcp-fs" } },
	skillsDirs: ["/x/skills"],
	promptsDirs: ["/x/prompts"],
	telemetry: {
		enabled: false,
		endpoint: "",
		token: "secret-token",
		flushIntervalMs: 0,
	},
	unknownFutureKey: { keep: "me" },
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hotpot-settings-"));
	settingsPath = join(dir, "settings.json");
	writeFileSync(
		settingsPath,
		`${JSON.stringify(diskSettings, null, 2)}\n`,
		"utf8",
	);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readUserSettings", () => {
	it("返回全量用户级视图，apiKey 与 token 掩码", () => {
		const view = readUserSettings(dir);
		expect(view.models.high.apiKey).toBe(API_KEY_MASK);
		expect(view.models.medium.apiKey).toBe(API_KEY_MASK);
		expect(view.models.low.apiKey).toBe(API_KEY_MASK);
		expect(view.webSearch?.apiKey).toBe(API_KEY_MASK);
		expect(view.telemetry?.token).toBe(API_KEY_MASK);
		expect(view.mainAgentTier).toBe("medium");
		expect(view.maxParallelTasks).toBe(6);
		expect(view.planMaxRevisions).toBe(2);
		expect(view.permission?.mode).toBe("ask-on-dangerous");
		expect(view.features).toEqual({ memory: true, compaction: false });
		expect(view.compaction).toEqual({
			triggerRatio: 0.7,
			keepRecentTokens: 15000,
		});
		expect(view.hooks?.Stop?.[0]?.matcher).toBe("*");
		expect(view.mcpServers).toEqual({ fs: { command: "mcp-fs" } });
		expect(view.skillsDirs).toEqual(["/x/skills"]);
		expect(view.promptsDirs).toEqual(["/x/prompts"]);
	});

	it("vector.embedding.apiKey：有值才掩码，空串原样返回（本地服务不鉴权）", () => {
		for (const [apiKey, expected] of [
			["secret-embed", API_KEY_MASK],
			["", ""],
		] as const) {
			writeFileSync(
				settingsPath,
				`${JSON.stringify(
					{
						...diskSettings,
						vector: {
							embedding: {
								model: "embed-v1",
								baseUrl: "https://e.example/v1",
								apiKey,
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
			expect(readUserSettings(dir).vector?.embedding?.apiKey).toBe(expected);
		}
	});

	it("文件缺失/坏 JSON/不合规抛带路径的错误", () => {
		rmSync(settingsPath);
		expect(() => readUserSettings(dir)).toThrow(/settings file not found/);
		writeFileSync(settingsPath, "not json", "utf8");
		expect(() => readUserSettings(dir)).toThrow(/not valid JSON/);
		writeFileSync(settingsPath, "[]", "utf8");
		expect(() => readUserSettings(dir)).toThrow(/must contain a JSON object/);
		writeFileSync(settingsPath, '{"models":{}}', "utf8");
		expect(() => readUserSettings(dir)).toThrow(/invalid settings/);
	});
});

describe("writeUserSettings", () => {
	it("全量写回：掩码字段保留磁盘原值，其余键覆盖，未知键保留", () => {
		const view = readUserSettings(dir);
		writeUserSettings(
			{
				...view,
				mainAgentTier: "high",
				maxParallelTasks: 8,
				features: { memory: false },
				telemetry: {
					enabled: true,
					endpoint: "https://t.example",
					token: API_KEY_MASK,
				},
			},
			dir,
		);
		const onDisk = JSON.parse(
			readFileSync(settingsPath, "utf8"),
		) as typeof diskSettings;
		// 掩码保留原值
		expect(onDisk.models.high.apiKey).toBe("secret-high");
		expect(onDisk.webSearch.apiKey).toBe("secret-search");
		expect(onDisk.telemetry.token).toBe("secret-token");
		// 显式覆盖生效
		expect(onDisk.mainAgentTier).toBe("high");
		expect(onDisk.maxParallelTasks).toBe(8);
		expect(onDisk.features).toEqual({ memory: false });
		expect(onDisk.telemetry.enabled).toBe(true);
		// 未触碰的键保持原值（hooks/mcpServers/permission 等）
		expect(onDisk.hooks).toEqual(diskSettings.hooks);
		expect(onDisk.mcpServers).toEqual(diskSettings.mcpServers);
		expect(onDisk.permission).toEqual(diskSettings.permission);
		expect(onDisk.compaction).toEqual(diskSettings.compaction);
		// 未知键原样保留
		expect(onDisk.unknownFutureKey).toEqual({ keep: "me" });
		// 写后读取视图再次掩码
		const reread = readUserSettings(dir);
		expect(reread.models.high.apiKey).toBe(API_KEY_MASK);
		expect(reread.mainAgentTier).toBe("high");
	});

	it("vector.embedding.apiKey 为掩码时写回保留磁盘原值", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{
					...diskSettings,
					vector: {
						embedding: {
							model: "embed-v1",
							baseUrl: "https://e.example/v1",
							apiKey: "secret-embed",
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		// 读出的是掩码，原样写回（模拟设置弹窗未改动该字段）
		writeUserSettings(readUserSettings(dir), dir);
		const onDisk = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			vector: { embedding: { apiKey: string } };
		};
		expect(onDisk.vector.embedding.apiKey).toBe("secret-embed");
	});
});
