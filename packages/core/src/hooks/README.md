# src/hooks/

生命周期钩子链（M4 Feature③），审批 waterfall 的公开版。

- `hooks.ts` — `createHookChain(...)` 返回 `HookChain`；`fire(event, payload?)` 按配置顺序执行用户定义的 shell 命令。
- 事件：`session_start` / `pre_tool` / `post_tool` / `turn_end`，对应 Claude Code 的 SessionStart / PreToolUse / PostToolUse / Stop。
- 执行约定：payload 经 stdin 喂 JSON（含 session_id/cwd/agent_id/hook_event 与事件特有字段）；env 带 `HOTPOT_HOOK_EVENT`；cwd = 会话 cwd；默认超时 `HOOK_DEFAULT_TIMEOUT_MS`（60s）。
- 阻断语义：仅 `pre_tool` 的非零退出码阻断工具（stdout+stderr 作为 isError 内容）；其余事件只记录；spawn 失败与超时 fail-open（exitCode = -1）。
- 每条命令执行后落一条 `hook/fired` 事件（审计 + 遥测）。
- 安全：hooks 只来自用户级 settings，项目级白名单不含 hooks。
- `index.ts` 是本特性的对外出口。
