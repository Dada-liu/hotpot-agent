// 依赖白名单不允许引入 @types/node，在此做最小 ambient 声明；运行时由 Node 提供真身。
// 只声明 src/ 与 test/ 实际用到的 API，用到新 API 时在此补充。

interface HotpotFileHandle {
	write(data: string): Promise<unknown>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

declare module "node:fs/promises" {
	export function open(path: string, flags: "a"): Promise<HotpotFileHandle>;
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<string | undefined>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function readdir(path: string): Promise<string[]>;
	export function appendFile(path: string, data: string): Promise<void>;
	export function mkdtemp(prefix: string): Promise<string>;
	export function rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
}

declare module "node:os" {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
}

declare module "node:crypto" {
	export function randomUUID(): string;
}

declare const process: {
	env: Record<string, string | undefined>;
};
