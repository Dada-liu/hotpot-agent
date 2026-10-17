// 静态托管测试（M3）：纯 API 模式（webDist/publicDir 均不存在）不劫持路由；
// 伪造 webDist 验证 SPA 兜底（/ 与任意非 /api 路径回 index.html）与 assets MIME；
// 伪造 publicDir 验证根路径资源直出与 404；/api 前缀永不被静态路由拦截。
// 直接用 app.request() 走 Hono，不开端口；manager 用 mkdtemp home 的空会话目录。
// 每个 mountStatic 调用都显式传齐两个路径（缺失语义传 mkdtemp 下不存在的子路径），
// 与真实仓库布局完全解耦——默认值会静默解析到 <仓库根>/packages/web/dist 与 <仓库根>/public，
// 工作树里存在构建产物时（如 Task 6/7 之后）未隔离的用例会被 SPA 兜底/真实 public 劫持。
// 真实仓库布局下的行为由 bin 冒烟覆盖（Task 5 已验证：logo.png 200 image/png、/ 404、/api 200）。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createSessionManager } from "../src/session-manager.ts";
import { mountStatic } from "../src/static.ts";

let home: string;
let webDist: string;
let publicDir: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hotpot-static-home-"));
	webDist = await mkdtemp(join(tmpdir(), "hotpot-static-dist-"));
	publicDir = await mkdtemp(join(tmpdir(), "hotpot-static-public-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(webDist, { recursive: true, force: true });
	await rm(publicDir, { recursive: true, force: true });
});

// 纯 API 模式夹具：两个目录都指向不存在的路径
function createApiOnlyApp() {
	const app = createApp(createSessionManager({ home }));
	mountStatic(app, {
		webDist: join(webDist, "missing-dist"),
		publicDir: join(publicDir, "missing-public"),
	});
	return app;
}

// 伪造 web 产物：index.html + assets/app.js
async function writeWebDist(): Promise<void> {
	await mkdir(join(webDist, "assets"), { recursive: true });
	await writeFile(join(webDist, "index.html"), "<h1>hotpot web</h1>", "utf8");
	await writeFile(
		join(webDist, "assets", "app.js"),
		"console.log(1);\n",
		"utf8",
	);
}

describe("纯 API 模式（webDist/publicDir 均不存在）", () => {
	it("GET /api/sessions 200，GET / 404（不被 SPA 兜底劫持）", async () => {
		const app = createApiOnlyApp();
		const api = await app.request("/api/sessions");
		expect(api.status).toBe(200);
		expect(await api.json()).toEqual({ sessions: [] });
		const root = await app.request("/");
		expect(root.status).toBe(404);
	});
});

describe("webDist 存在（SPA + assets）", () => {
	it("/ 与任意非 /api 路径回退 index.html（text/html）", async () => {
		await writeWebDist();
		const app = createApp(createSessionManager({ home }));
		mountStatic(app, { webDist, publicDir: join(publicDir, "missing-public") });
		for (const path of ["/", "/some/spa/route"]) {
			const res = await app.request(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			expect(await res.text()).toContain("hotpot web");
		}
	});

	it("GET /assets/app.js 返回 js 与正确 MIME", async () => {
		await writeWebDist();
		const app = createApp(createSessionManager({ home }));
		mountStatic(app, { webDist, publicDir: join(publicDir, "missing-public") });
		const res = await app.request("/assets/app.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
		expect(await res.text()).toContain("console.log");
	});

	it("静态路由不拦截 /api 前缀", async () => {
		await writeWebDist();
		const app = createApp(createSessionManager({ home }));
		mountStatic(app, { webDist, publicDir: join(publicDir, "missing-public") });
		const res = await app.request("/api/sessions");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sessions: [] });
	});
});

describe("publicDir 存在（根 public/ 直出）", () => {
	it("GET /logo.png 200 且 image/png；不存在文件 404", async () => {
		// 假 PNG 头字节（非完整格式，仅验证字节直出与 MIME）
		const bytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		await writeFile(join(publicDir, "logo.png"), bytes);
		const app = createApp(createSessionManager({ home }));
		mountStatic(app, { webDist: join(webDist, "missing-dist"), publicDir });
		const res = await app.request("/logo.png");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
		const missing = await app.request("/nope.png");
		expect(missing.status).toBe(404);
	});
});
