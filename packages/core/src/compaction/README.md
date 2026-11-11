# src/compaction/

上下文自动压缩以会话 JSONL 为唯一事实源，不维护额外的内存历史。

- `estimate.ts` — `estimateTokens(messages, system, tools)` 将消息、system 与工具声明完整序列化，按保守字符数估算 token；消息中的 tool 调用参数也计入。
- `compaction.ts` — `maybeCompact(cfg, system, events, signal)` 在每个正式 LLM 请求前检查 `(contextWindow - maxTokens) * triggerRatio`。`triggerRatio` 默认 `0.8`，`keepRecentTokens` 默认 `20000`；`features.compaction` 默认开启。
- 超阈值时，从最新有效压缩点之后由尾向前保留约 `keepRecentTokens` 的完整历史；assistant 的 tool_call 与对应 tool_result 作为同一组，即使该组超过保留预算也不会拆开。
- 摘要请求复用当前 adapter、model、apiKey、baseUrl 和 system，但 `tools=[]`，直接调用 adapter，不递归进入 `runTurn`。成功后追加 `compaction` 事件，再由 `deriveMessages` 注入 user 角色摘要。
- 摘要失败或 abort 时不落压缩事件，也不继续发送已知超限的正式请求。压缩后仍超阈值返回 `context_limit`；已完整写入的压缩事件保留供恢复审计。
