// 用法：pnpm dev <pkg> [args...]
// 把包名映射到 packages/<pkg>/src/bin.ts 并用 tsx 直跑（开发模式，无需构建）。
// 例：pnpm dev cli chat
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const [pkg, ...args] = process.argv.slice(2);

if (!pkg || !/^[a-z][a-z0-9-]*$/.test(pkg)) {
	console.error(
		"用法: pnpm dev <pkg> [args...]（pkg 为 packages/ 下的目录名，如 cli）",
	);
	process.exit(1);
}

const entry = `packages/${pkg}/src/bin.ts`;
if (!existsSync(entry)) {
	console.error(`入口不存在: ${entry}（@hotpot/${pkg} 暂无可运行入口）`);
	process.exit(1);
}

// 经 pnpm scripts 运行时 node_modules/.bin 已在 PATH 中，可直接解析 tsx
const child = spawn("tsx", [entry, ...args], {
	stdio: "inherit",
	shell: process.platform === "win32",
});

child.on("exit", (code) => {
	process.exit(code ?? 1);
});
