// 依赖白名单不允许引入 @types/node（见 packages/ai/tsconfig.json 注释）。
// 测试只用到 node:fs/promises 的 readFile，在此做最小 ambient 声明；运行时由 Node 提供真身。
declare module "node:fs/promises" {
	export function readFile(path: URL): Promise<Uint8Array>;
}
