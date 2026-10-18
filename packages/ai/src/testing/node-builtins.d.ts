// 依赖白名单不允许引入 @types/node；testing/ 的录制回放只用到
// node:fs/promises 的 appendFile 与 readFile，在此做最小 ambient 声明。
// 运行时由 Node 22 提供真身。
declare module "node:fs/promises" {
	export function appendFile(path: string, data: string): Promise<void>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
}
