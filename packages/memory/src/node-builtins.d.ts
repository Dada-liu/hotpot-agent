// 依赖白名单不允许引入 @types/node，在此只声明源码与测试实际使用的 Node API
interface HotpotFileHandle {
	write(data: Uint8Array): Promise<{ bytesWritten: number }>;
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
	export function appendFile(path: string, data: string): Promise<void>;
	export function writeFile(
		path: string,
		data: string,
		options?: { flag?: string },
	): Promise<void>;
	export function mkdtemp(prefix: string): Promise<string>;
	export function rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
}

declare module "node:fs" {
	export function existsSync(path: string): boolean;
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
	export function dirname(path: string): string;
}
