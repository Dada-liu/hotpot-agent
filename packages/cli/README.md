# @hotpot/cli

行式交互入口 `hotpot chat`（M1 唯一的用户界面）。

- `src/bin.ts` 可运行入口（package.json 的 `bin.hotpot` 指向它），开发时用根目录 `pnpm dev cli chat` 经 tsx 直跑。
- 行式交互循环：输入消息 → 流式打印文本 → `[tool] name(参数摘要)` 展示 tool call → approval 询问 `y/n`（默认 n，fail-closed）→ 结果摘要；`/exit` 退出，Ctrl-C 中断当前回合而不退出进程。
- `hotpot chat [--session <path>] [--tier high|medium|low]`；tier 缺省取 `settings.mainAgentTier`，再缺省 `high`。`--session` 恢复会话（`resumeSession` 追加到同一文件，`runTurn` 内部 `loadSession` + `deriveMessages` 重建历史）。
- 配置经 `@hotpot/core` 的 `loadSettings({ cwd })` 双层读取：用户级 `~/.hotpot/settings.json`（`HOTPOT_HOME` 可覆盖，三档模型与凭证必填）+ 项目级 `.hotpot/settings.json`（自 cwd 向上查找、可选，只覆盖非凭证白名单字段）；真实适配器由 `resolveModelAdapter` 按 `ModelRef` 的 provider→api 映射选择，未知模型按 provider 名推断协议并告警（contextWindow 取 128000）。

当前状态：M1 已完成（Task 11 交付本包全部能力，Task 12 补 M1 验收测试 `test/acceptance.test.ts`），见 `src/`、`test/` 目录文档。
