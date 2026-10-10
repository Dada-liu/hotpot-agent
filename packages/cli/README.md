# @hotpot/cli

行式交互入口 `hotpot chat`（M1 唯一的用户界面）。

职责（M1 计划）：

- `src/bin.ts` 可运行入口，开发时用根目录 `pnpm dev cli chat` 经 tsx 直跑。
- 行式交互循环：输入消息 → 流式打印文本 → 展示 tool call 名称与参数摘要 → approval 询问 `y/n` → 结果摘要；`/exit` 退出。
- `--session <path>` 恢复会话（`loadSession` + `deriveMessages` 续聊）。

当前状态：脚手架（Task 1），入口在 Task 11 实现。
