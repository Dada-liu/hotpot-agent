# src/agent/

turn/step 循环（M1 核心）：turn = 一次用户意图的完整处理，step = 一次 `streamChat` + 该消息全部 tool call 的执行。

- `types.ts` — 公开契约。`LoopConfig` 收拢 `runTurn` 的全部入参（session/agentId/adapter/model/apiKey/baseUrl/registry/approval/cwd/system）；`system` 缺省时用 `buildSystemPrompt` + `registerDefaultSections` 组装（注册非幂等，有模块级守卫）。`AgentEvent` 是产出给 UI 的事件：`text` / `tool_call` / `tool_result` / `done` / `error`。
- `loop.ts` — `runTurn(cfg, signal)`。每个 step 前 `loadSession` + `deriveMessages` 从事件日志重建历史（日志即唯一事实源）；assistant 流事件实时转成 `AgentEvent`；消息完整接收后落盘 `assistant_msg`（含 usage/model/agentId），再执行 tool call 并逐个落盘 `tool_result`。
- 并发规则：同批 tool call 全部 `isConcurrencySafe` 才 `Promise.all` 并行，否则按序执行（abort 时未开始的调用跳过）；并行结果按调用顺序落盘与产出。
- 失败兜底：未知工具名、execute rejection（registry 擦除层的 ZodError、fs 错误等）都转成 isError tool_result，不向调用方抛。
- 防御：`finish=max_tokens` 时该消息全部 tool call 记 isError（「arguments may be truncated」）不执行，错误结果落盘后继续下一 step；`AbortSignal` 贯穿流式请求与工具执行，中断时已落盘事件保留，产出 `done(aborted)`。
