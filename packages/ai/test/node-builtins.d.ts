// 依赖白名单不允许引入 @types/node（见 packages/ai/tsconfig.json 注释）。
// 测试用到 fixture 读取与临时目录，在此做最小 ambient 声明；运行时由 Node 提供真身。
declare module "node:fs/promises" {
	export function readFile(path: URL): Promise<Uint8Array>;
	export function writeFile(path: string, data: string): Promise<void>;
	export function mkdtemp(prefix: string): Promise<string>;
	export function rm(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:path" {
	export function join(...parts: string[]): string;
}
