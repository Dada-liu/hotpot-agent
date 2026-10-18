// 匿名安装 ID：本机首次运行时生成 UUID，之后一直复用。
// 同步 API 是刻意的：调用方 createSessionManager 是同步的，这里也只读写一个小小的本地文件。
// 用户态与 benchmark 态各存一份，互不覆盖：benchmark 环境不应污染真实用户的设备标识。

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "@hotpot/core";
import type { TelemetryKind } from "./events.ts";

// 只校验 UUID 形状；大小写不敏感，避免外部手工写入的大写形式被判为非法后反复重写
const INSTALL_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILE_NAMES: Record<TelemetryKind, string> = {
	user: "install-id",
	benchmark: "benchmark-install-id",
};

export interface LoadOrCreateInstallIdOptions {
	home?: string;
	kind?: TelemetryKind;
}

export function loadOrCreateInstallId(
	opts: LoadOrCreateInstallIdOptions = {},
): string {
	const dir = join(resolveHome(opts.home), "telemetry");
	const path = join(dir, FILE_NAMES[opts.kind ?? "user"]);

	const existing = readInstallId(path);
	if (existing !== undefined) {
		return existing;
	}

	const installId = randomUUID();
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, installId, "utf8");
	return installId;
}

function readInstallId(path: string): string | undefined {
	try {
		const value = readFileSync(path, "utf8").trim();
		return INSTALL_ID_PATTERN.test(value) ? value : undefined;
	} catch {
		// 文件不存在或不可读：当作缺失，走重新生成
		return undefined;
	}
}
