# 会话日志

hotpot-agent 的**会话 JSONL 事件日志是唯一事实源**：append-only，存储在 `~/.hotpot/sessions/` 下，每个会话一个文件。

## 为什么以日志为准

传统 agent 把「对话历史」放在内存里，落盘只是持久化副本，两个状态需要同步。hotpot-agent 反过来：**模型历史不是状态，而是从日志现算出来的**。每个 step 由 `deriveMessages()` 从 JSONL 转换出模型所需的消息列表。

由此得到三个免费属性：

1. **可恢复**：kill 进程后用同一会话重启，`loadSession` + `deriveMessages` 重建 main 历史（worker 事件按 agentId 过滤），继续对话。
2. **可审计**：审批 waterfall 的每次 asked / decided、plan 的 drafted / approved / denied、steer 的注入与消费，全部作为事件落盘。
3. **可度量**：每次 LLM 调用的 usage、每个工具的耗时与结果都在日志里，token 统计与遥测直接从日志折叠，不经第二份账本。

## 事件类型

日志中的事件（JSONL v1 规范）覆盖会话全生命周期，包括：`user_msg` / `assistant_msg`（含 tool_call 块与 usage）、`tool_result`、`approval/asked` 与 `approval/decided`（经 `createAuditedApprovalChain` 落盘）、`plan/drafted` / `plan/approved` / `plan/denied`、`spawn`（worker/task 诞生）、`inbox/spliced`（steer/queue 注入）、todo 集合、hook 触发、skill 加载、prompt 模板展开、MCP 接入等。

新功能引入的事件类型必须纳入 JSONL v1 规范，这是 M4 起的硬性验收项——保证日志始终能完整重建上下文。

## deriveMessages

`deriveMessages()` 的职责是从事件流折叠出模型历史：用户消息、assistant 消息（含工具调用）、工具结果按序排列，被中断的半回合不进入历史，压缩点（未来的上下文压缩功能）之后的折叠规则由日志中的保留点事件决定。

## 存储与位置

- 用户级根目录：`~/.hotpot/`（可用 `HOTPOT_HOME` 覆盖），会话文件在 `~/.hotpot/sessions/*.jsonl`。
- 恢复会话：`hotpot chat --session <文件路径>`。
- server 层用 tailer 只读新增字节消费日志：坏行跳过、半行留待下次拼接，断线重连按字节偏移续读补发（见 [Web 端](/guide/web)）。
