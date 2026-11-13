// `pnpm exp` 的入口：把参数交给 runExperimentCli，用退出码表达成败。
// 单独一个文件是为了让 cli.ts 保持可 import（测试直接调用，不经过进程退出）。

import { runExperimentCli } from "./cli.ts";

process.exitCode = await runExperimentCli(process.argv.slice(2));
