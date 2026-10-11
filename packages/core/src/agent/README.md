# src/agent/

turn/step 循环（M1 核心）：turn = 一次用户意图的完整处理，step = 一次 `streamChat` + 该消息全部 tool call 的执行。

- `types.ts` — 公开契约。`LoopConfig` 收拢 `runTurn` 的全部入参（session/agentId/adapter/model/apiKey/baseUrl/registry/approval/cwd/system）；`system` 缺省时用 `buildSystemPrompt` + `registerDefaultSections` 组装（注册非幂等，有模块级守卫）。`AgentEvent` 是产出给 UI 的事件：`text` / `tool_call` / `tool_result` / `done` / `error`。
- `loop.ts` — `runTurn(cfg, signal)`。每个 step 前 `loadSession` + `deriveMessages` 从事件日志重建历史（日志即唯一事实源）；assistant 流事件实时转成 `AgentEvent`；消息完整接收后落盘 `assistant_msg`（含 usage/model/agentId），再执行 tool call 并逐个落盘 `tool_result`。
- 并发规则：同批 tool call 全部 `isConcurrencySafe` 才 `Promise.all` 并行，否则按序执行。串行路径 abort 时未开始的调用不再执行，但仍补落 isError tool_result（"not executed: aborted"）——assistant_msg 已含全部 tool_call，缺 tool_result 会让下一轮请求被 API 拒绝；并行结果按调用顺序落盘与产出。
- 失败兜底：未知工具名、execute rejection（registry 擦除层的 ZodError、fs 错误等）都转成 isError tool_result，不向调用方抛。
- 防御：`finish=max_tokens` 时该消息全部 tool call 记 isError 不执行，错误结果落盘后继续下一 step。`finish=error`（provider 返回未映射的 stop reason）同样不执行：每个 tool call 补落 isError tool_result 后 `done(error)` 结束 turn，不在错误状态上继续。tool_call 的 `input` 恒以对象落盘：解析失败或非对象的 JSON（如截断的半截参数）落 `{}` 占位，原始片段（截到 200 字符）写进 isError tool_result 文本——下一步请求不会把字符串当 input 发给 API（Anthropic 要求 object）。
- `AbortSignal` 贯穿流式请求与工具执行，中断时已落盘事件保留，产出 `done(aborted)`。流式中途 abort 表现为适配器 fetch 的 AbortError rejection：catch 里先判 `signal.aborted`，直接 `done(aborted)`，不记 error 会话事件。
