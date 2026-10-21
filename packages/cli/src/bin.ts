#!/usr/bin/env tsx
// hotpot CLI 入口：逻辑全部在 chat.ts（IO 可注入、可测试），本文件只做进程级接线
import { runChatCli } from "./chat.ts";

process.exitCode = await runChatCli(process.argv.slice(2));
