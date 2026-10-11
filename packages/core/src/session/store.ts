// 会话事件日志的读写：append-only JSONL，日志即唯一事实源
// 路径规则：$HOTPOT_HOME/sessions/<cwd 编码>/<yyyymmdd-hhmmss>_<session-id>.jsonl
// 崩溃最多丢最后一行：每次 append 后 fsync；loadSession 跳过无法解析的行

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "./events.ts";

export interface Session {
	id: string;
	filePath: string;
	append(e: SessionEvent): Promise<void>;
}

export interface SessionSummary {
	id: string;
	filePath: string;
	createdAt: string;
	cwd: string;
}

// home 优先级：参数 > HOTPOT_HOME 环境变量 > ~/.hotpot-code
// 导出供 config.ts 复用，保证 settings 与会话日志的 home 解析规则一致
export function resolveHome(home?: string): string {
	if (home) {
		return home;
	}
	const env = process.env.HOTPOT_HOME;
	if (env) {
		return env;
	}
	return join(homedir(), ".hotpot-code");
}

// cwd 编码：/ 与 : 替换为 -（如 /Users/a/proj → -Users-a-proj）
export function encodeCwd(cwd: string): string {
	return cwd.replace(/[/:]/g, "-");
}

// 文件名时间戳：yyyymmdd-hhmmss，本地时间
function fileTimestamp(d: Date): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 追加一行并 fsync：open/write/sync/close，保证崩溃最多丢最后一行
async function appendLine(filePath: string, line: string): Promise<void> {
	const handle = await open(filePath, "a");
	try {
		await handle.write(line);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

// 创建会话：建目录、写 meta 首行，返回的 append 句柄供后续事件写入
export async function createSession(
	cwd: string,
	home?: string,
): Promise<Session> {
	const id = randomUUID();
	const dir = join(resolveHome(home), "sessions", encodeCwd(cwd));
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, `${fileTimestamp(new Date())}_${id}.jsonl`);
	const session: Session = {
		id,
		filePath,
		append: (e: SessionEvent) => appendLine(filePath, `${JSON.stringify(e)}\n`),
	};
	await session.append({
		type: "meta",
		sessionId: id,
		createdAt: new Date().toISOString(),
		cwd,
		formatVersion: 1,
	});
	return session;
}

// 按行解析加载；崩溃可能留下末尾半行，无法解析的行跳过。meta 必须是首行，缺失视为文件损坏
export async function loadSession(
	filePath: string,
): Promise<{ meta: SessionEvent; events: SessionEvent[] }> {
	const text = await readFile(filePath, "utf8");
	const events: SessionEvent[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		try {
			events.push(JSON.parse(line) as SessionEvent);
		} catch {
			// 坏行跳过（典型是崩溃留下的末尾半行）
		}
	}
	const meta = events[0];
	if (meta?.type !== "meta") {
		throw new Error(`session file missing meta event: ${filePath}`);
	}
	return { meta, events };
}

// 恢复已有会话供续聊（CLI --session）：loadSession 校验 meta 后返回指向同一文件的 append 句柄，
// 追加仍走 appendLine（带 fsync），与 createSession 的崩溃语义一致
export async function resumeSession(filePath: string): Promise<Session> {
	const { meta } = await loadSession(filePath);
	if (meta.type !== "meta") {
		throw new Error(`session file missing meta event: ${filePath}`);
	}
	return {
		id: meta.sessionId,
		filePath,
		append: (e: SessionEvent) => appendLine(filePath, `${JSON.stringify(e)}\n`),
	};
}

// 列出 home 下全部会话；读每个文件首行 meta 提取摘要，损坏文件跳过
export async function listSessions(home?: string): Promise<SessionSummary[]> {
	const sessionsDir = join(resolveHome(home), "sessions");
	let cwdDirs: string[];
	try {
		cwdDirs = await readdir(sessionsDir);
	} catch {
		return []; // sessions 目录不存在：尚无会话
	}
	const summaries: SessionSummary[] = [];
	for (const cwdDir of cwdDirs) {
		let files: string[];
		try {
			files = await readdir(join(sessionsDir, cwdDir));
		} catch {
			continue; // sessions/ 下的非目录项
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) {
				continue;
			}
			const filePath = join(sessionsDir, cwdDir, file);
			try {
				const { meta } = await loadSession(filePath);
				if (meta.type !== "meta") {
					continue;
				}
				summaries.push({
					id: meta.sessionId,
					filePath,
					createdAt: meta.createdAt,
					cwd: meta.cwd,
				});
			} catch {
				// 损坏的会话文件不影响列表
			}
		}
	}
	// 按创建时间排序，保证输出稳定
	summaries.sort(
		(a, b) =>
			a.createdAt.localeCompare(b.createdAt) ||
			a.filePath.localeCompare(b.filePath),
	);
	return summaries;
}
