// 用户记忆：人工可编辑的 Markdown 文件；读取有界且失败降级，写入追加后 fsync

import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHome } from "../session/store.ts";

const MAX_SUMMARY_CHARS = 8000;
const TRUNCATION_NOTICE = "[... older memory truncated ...]";

// 截断只按完整 Markdown 列表条目向末尾选取，续行归属于其所属条目
function truncateSummary(text: string): string {
	const entries: string[] = [];
	let current = "";
	for (const line of text.trimEnd().split("\n")) {
		if (/^(?:[-*+]|\d+[.)])\s+/.test(line)) {
			if (current !== "") {
				entries.push(current);
			}
			current = line;
		} else {
			current = current === "" ? line : `${current}\n${line}`;
		}
	}
	if (current !== "") {
		entries.push(current);
	}

	let selected = "";
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] ?? "";
		const candidate = selected === "" ? entry : `${entry}\n${selected}`;
		if (TRUNCATION_NOTICE.length + 1 + candidate.length > MAX_SUMMARY_CHARS) {
			break;
		}
		selected = candidate;
	}
	return selected === ""
		? TRUNCATION_NOTICE
		: `${TRUNCATION_NOTICE}\n${selected}`;
}

export async function readMemorySummary(home?: string): Promise<string> {
	try {
		const text = await readFile(join(resolveHome(home), "MEMORY.md"), "utf8");
		return text.length <= MAX_SUMMARY_CHARS ? text : truncateSummary(text);
	} catch {
		// 记忆是可选上下文，缺失或不可读都不能阻断普通 turn
		return "";
	}
}

export async function appendMemory(
	content: string,
	home?: string,
): Promise<void> {
	const trimmed = content.trim();
	if (trimmed === "") {
		throw new Error("Memory content must not be empty");
	}

	const directory = resolveHome(home);
	await mkdir(directory, { recursive: true });
	const filePath = join(directory, "MEMORY.md");
	let existing: string | undefined;
	try {
		existing = await readFile(filePath, "utf8");
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}
	}

	const lines = trimmed.split(/\r?\n/);
	const item = `- ${lines[0]}${lines
		.slice(1)
		.map((line) => `\n  ${line}`)
		.join("")}\n`;
	const prefix =
		existing === undefined
			? "# User Memory\n"
			: existing === "" || existing.endsWith("\n")
				? ""
				: "\n";

	const handle = await open(filePath, "a");
	try {
		await handle.write(prefix + item);
		await handle.sync();
	} finally {
		await handle.close();
	}
}
