// 打开系统浏览器：只做尽力而为的启动，失败提示手动访问，不影响 server 运行。
import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
	const opener =
		process.platform === "darwin"
			? { command: "open", args: [url] }
			: process.platform === "win32"
				? { command: "cmd", args: ["/c", "start", "", url] }
				: { command: "xdg-open", args: [url] };
	const child = spawn(opener.command, opener.args, {
		stdio: "ignore",
		detached: true,
	});
	child.on("error", () => {
		process.stderr.write(`无法自动打开浏览器，请手动访问 ${url}\n`);
	});
	child.unref();
}
