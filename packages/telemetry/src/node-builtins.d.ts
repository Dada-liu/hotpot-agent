// 依赖白名单不允许引入 @types/node，在此做最小 ambient 声明；运行时由 Node 提供真身。
// 只声明 src/ 与 test/ 实际用到的 API，用到新 API 时在此补充。

declare module "node:fs" {
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function writeFileSync(
		path: string,
		data: string,
		encoding?: "utf8",
	): void;
	export function mkdirSync(
		path: string,
		options?: { recursive?: boolean },
	): string | undefined;
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
