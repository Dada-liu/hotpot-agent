// 静态托管（M3 server）：server 直出 web 产物与仓库根 public/ 资产，零依赖（node:fs 自读）。
// - webDist（默认 <仓库根>/packages/web/dist）：/assets/* 等产物文件按扩展名给 Content-Type；
//   / 与任意非 /api 路径的 GET 回退 index.html（SPA 兜底）
// - publicDir（默认 <仓库根>/public）：路径 /<文件名> 原样直出（logo.png 等）
// - 两个目录都不存在：什么都不挂（纯 API 模式，不报错）
// - /api 前缀永不进静态路由；URL 路径先规范化并拒绝逃逸根目录（../ 与绝对路径）

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";

export interface MountStaticOptions {
	// vite 构建产物目录；缺省按 import.meta.url 相对定位 <仓库根>/packages/web/dist
	webDist?: string;
	// 根 public 资产目录；缺省 <仓库根>/public
	publicDir?: string;
}

// Content-Type 按扩展名（不含点，小写）
const CONTENT_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	png: "image/png",
	webp: "image/webp",
	svg: "image/svg+xml",
	json: "application/json; charset=utf-8",
};
const DEFAULT_MIME = "application/octet-stream";

// 本文件编译产物位于 packages/server/src|dist 下，向上三级即仓库根
function defaultRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

// URL 路径 → 根目录内文件路径；decode 失败或规范化后逃逸根目录（../ 等）返回 null
function resolveUnderRoot(root: string, urlPath: string): string | null {
	let pathname: string;
	try {
		pathname = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	const full = join(root, pathname);
	const prefix = root.endsWith(sep) ? root : root + sep;
	if (full !== root && !full.startsWith(prefix)) return null;
	return full;
}

async function tryFile(filePath: string): Promise<Response | null> {
	let data: Uint8Array<ArrayBuffer>;
	try {
		data = await readFile(filePath);
	} catch {
		return null;
	}
	const mime = CONTENT_TYPES[extname(filePath).slice(1).toLowerCase()];
	return new Response(data, {
		headers: { "Content-Type": mime ?? DEFAULT_MIME },
	});
}

export function mountStatic(app: Hono, opts: MountStaticOptions = {}): void {
	const root = defaultRoot();
	const webDist = opts.webDist ?? join(root, "packages", "web", "dist");
	const publicDir = opts.publicDir ?? join(root, "public");
	const webDistOn = isDir(webDist);
	const publicDirOn = isDir(publicDir);
	// 纯 API 模式：不挂任何静态路由
	if (!webDistOn && !publicDirOn) return;

	app.get("*", async (c) => {
		const path = c.req.path;
		// /api 前缀永远走 API 路由（未命中则由 Hono 默认 404）
		if (path === "/api" || path.startsWith("/api/")) return c.notFound();
		if (publicDirOn) {
			const file = resolveUnderRoot(publicDir, path);
			const resp = file === null ? null : await tryFile(file);
			if (resp !== null) return resp;
		}
		if (webDistOn) {
			const file = resolveUnderRoot(webDist, path);
			const resp = file === null ? null : await tryFile(file);
			if (resp !== null) return resp;
			// SPA 兜底：产物内没有对应文件时回 index.html
			const index = await tryFile(join(webDist, "index.html"));
			if (index !== null) return index;
		}
		return c.notFound();
	});
}
