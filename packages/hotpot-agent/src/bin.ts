#!/usr/bin/env node
// hotpot 发布入口：hotpot / hotpot chat 进终端 REPL，hotpot web 启动本地 Web。
import { runCli } from "./cli.ts";

process.exitCode = await runCli(process.argv.slice(2));
