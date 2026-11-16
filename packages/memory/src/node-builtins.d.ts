// 依赖白名单不允许引入 @types/node，在此只声明源码与测试实际使用的 Node API
interface HotpotFileHandle {
	write(data: Uint8Array): Promise<{ bytesWritten: number }>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

interface HotpotDirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

interface HotpotHash {
	update(data: string | Uint8Array): HotpotHash;
	digest(encoding: "hex"): string;
}

declare module "node:crypto" {
	export function createHash(algorithm: "sha256"): HotpotHash;
	export function randomUUID(): string;
}

declare module "node:fs/promises" {
	export function open(
		path: string,
		flags: "a" | "wx",
	): Promise<HotpotFileHandle>;
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<string | undefined>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function readFile(path: string): Promise<Uint8Array>;
	export function readdir(
		path: string,
		options: { withFileTypes: true },
	): Promise<HotpotDirectoryEntry[]>;
	export function stat(
		path: string,
	): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
	export function symlink(target: string, path: string): Promise<void>;
	export function utimes(path: string, atime: Date, mtime: Date): Promise<void>;
	export function appendFile(path: string, data: string): Promise<void>;
	export function rename(oldPath: string, newPath: string): Promise<void>;
	export function unlink(path: string): Promise<void>;
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
	export function basename(path: string): string;
	export function join(...parts: string[]): string;
	export function dirname(path: string): string;
	export function isAbsolute(path: string): boolean;
	export function relative(from: string, to: string): string;
	export function resolve(...parts: string[]): string;
}
