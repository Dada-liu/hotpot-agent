# @hotpot/cli

行式交互入口 `hotpot chat`（M2 三层编排的用户界面）。

- `src/bin.ts` 可运行入口（package.json 的 `bin.hotpot` 指向它），开发时用根目录 `pnpm dev cli chat` 经 tsx 直跑。
- 行式交互循环：输入消息 → `runMainTurn` 编排（main 的 `delegate` 判定 → simple 派 worker 内联执行、complex 起草 plan 等审批）→ 流式打印文本 → `[spawn] worker-1 (tier=low): <task>` 展示子 agent 诞生 → `[tool] name(参数摘要)` / `[tool_result]` 展示 main 的工具调用 → `[plan] drafted/approved/denied` 展示计划审批流；`/exit` 退出，Ctrl-C 中断当前回合而不退出进程。
- 文件操作全在 worker/task 层：worker 事件不外传，其结果经 `delegate`/`spawn_workers` 的 tool_result 摘要回到终端；危险 command/write 审批询问在 worker 工具执行内触发，终端交互与 M1 一致，且 asked/decided 经 `createAuditedApprovalChain` 落盘会话日志。approval policy（`never`/`always`/`ask-on-dangerous`，缺省后者）作用于 worker 工具链：`always` 时经 runtime 的 `decorateWorkerTool` 通道给 bash/write/edit 包一层预审批。
- complex 流的 plan 审批在终端就地审阅：打印 plan 全文，输入 `y` 批准、`n` 拒绝、其他非空行批注（进入修订循环）、空行/EOF 拒绝（fail-closed）；`planMaxRevisions` 从 settings 透传。
- steer/queue 双队列：turn 结束后 drain next-turn 队列、按序补发为新用户消息；next-step 消息经 `runMainTurn` 的 inbox 接线在每个 step 顶部注入模型历史；Ctrl-C 同时 abort 当前回合的 AbortController 与 `inbox.cancel()`。
- `hotpot chat [--session <path>] [--tier high|medium|low]`；`--tier` 是主 agent 档，缺省取 `settings.mainAgentTier`，再缺省 `high`。`--session` 恢复会话（`resumeSession` 追加到同一文件，`runTurn` 内部 `loadSession` + `deriveMessages` 重建 main 历史，worker 事件按 agentId 过滤）。
- 配置经 `@hotpot/core` 的 `loadSettings({ cwd })` 双层读取：用户级 `~/.hotpot/settings.json`（`HOTPOT_HOME` 可覆盖，三档模型与凭证必填）+ 项目级 `.hotpot/settings.json`（自 cwd 向上查找、可选，只覆盖非凭证白名单字段）；真实适配器由 `@hotpot/orchestrator` 的 `resolveModel` 按 `ModelRef` 的 provider→api 映射选择，未知模型按 provider 名推断协议并告警（contextWindow 取 128000）。

当前状态：M2 编排接入已完成（Task 11）：`runChat` 主干走 `runMainTurn`，plan 终端审批见 `src/plan-approval.ts`，测试（含 M1 验收场景的编排流迁移版）见 `test/`。
