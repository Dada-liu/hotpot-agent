# @hotpot/core

agent 内核，不依赖任何 UI。

职责（M1 计划）：

- 会话事件日志：append-only JSONL 为唯一事实源，`deriveMessages` 折叠历史；加载跳过末尾损坏行。
- 系统提示词 section 注册表（按 order 拼接，prompt 文案全英文）。
- 工具框架：`execute`/`render`/`present` 三面分离；bash、read、write、edit 四个基础工具。
- 审批 waterfall：`ApprovalChain` 顺序询问，全部 next 时默认 deny（fail-closed）。
- turn/step 两级循环 `runTurn`；含 max_tokens 截断防御与 abort 落盘语义。
- 配置加载 `loadSettings`（zod 校验，apiKey 支持 `$ENV` 引用）。

当前状态：会话事件日志（`src/session/`）、section 注册表（`src/prompt/`）、工具框架与审批链（`src/tools/`、`src/approval/`）已完成，其余见后续任务。架构依据：`docs/archive/02-architecture.md`。
