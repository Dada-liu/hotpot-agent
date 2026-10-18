// 依赖白名单不允许引入 @types/node，在此做最小 ambient 声明；运行时由 Node 提供真身。
// 注意：本包经 workspace 源码直引 @hotpot/core，tsc 会把 core 的源码拉进同一编译，
// 因此本文件必须是 packages/core/src/node-builtins.d.ts 的超集，再加上 cli 自身用到的 API。

interface HotpotFileHandle {
	write(data: string): Promise<unknown>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

// readdir withFileTypes 形态的目录项：core skills.ts 递归扫描用它区分文件/目录
interface HotpotDirent {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

// 子进程 stdout/stderr 的可读流（只用到 data 事件；chunk 运行时是 Buffer，结构上有 toString）
interface HotpotChildStream {
	on(event: "data", listener: (chunk: { toString(): string }) => void): void;
}

declare module "node:fs/promises" {
	export function open(path: string, flags: "a"): Promise<HotpotFileHandle>;
	export function mkdir(
		path: string,
		options?: { recursive?: boolean },
	): Promise<string | undefined>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function writeFile(path: string, data: string): Promise<void>;
	export function readdir(path: string): Promise<string[]>;
	export function readdir(
		path: string,
		options: { withFileTypes: true },
	): Promise<HotpotDirent[]>;
	export function appendFile(path: string, data: string): Promise<void>;
	export function mkdtemp(prefix: string): Promise<string>;
	export function rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
}

declare module "node:fs" {
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:child_process" {
	export interface HotpotChildProcess {
		stdout: HotpotChildStream | null;
		stderr: HotpotChildStream | null;
		kill(signal?: string): boolean;
		on(event: "error", listener: (err: Error) => void): void;
		// close 在进程退出且 stdio 流全部关闭后触发，用它结算可避免丢失末尾输出
		on(
			event: "close",
			listener: (code: number | null, signal: string | null) => void,
		): void;
	}
	export function spawn(
		command: string,
		args: string[],
		options?: { cwd?: string },
	): HotpotChildProcess;
}

declare module "node:os" {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module "node:path" {
	export function basename(path: string): string;
	export function join(...parts: string[]): string;
	export function resolve(...parts: string[]): string;
	export function dirname(path: string): string;
}

declare module "node:crypto" {
	export function randomUUID(): string;
}

declare module "node:readline" {
	// line/close 覆盖行式读取；SIGINT 覆盖 TTY raw 模式下的 ^C（该模式不产生进程信号）
	export interface HotpotReadlineInterface {
		on(event: "line", listener: (line: string) => void): void;
		on(event: "close", listener: () => void): void;
		on(event: "SIGINT", listener: () => void): void;
		close(): void;
	}
	export function createInterface(options: {
		input: unknown;
		terminal?: boolean;
	}): HotpotReadlineInterface;
}

interface HotpotWritable {
	write(text: string): boolean;
}

declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	platform: string;
	cwd(): string;
	exitCode: number;
	stdin: unknown;
	stdout: HotpotWritable;
	stderr: HotpotWritable;
	on(event: "SIGINT", listener: () => void): void;
	removeListener(event: "SIGINT", listener: () => void): void;
};
