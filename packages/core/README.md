# @hotpot/core

agent 内核，不依赖任何 UI。

职责（M1 计划）：

- 会话事件日志：append-only JSONL 为唯一事实源，`deriveMessages` 转换历史；加载跳过末尾损坏行。
- 系统提示词 section 注册表（按 order 拼接，prompt 文案全英文）。
- 工具框架：`execute`/`render`/`present` 三面分离；bash、read、write、edit 四个基础工具。
- 审批 waterfall：`ApprovalChain` 顺序询问，全部 next 时默认 deny（fail-closed）；`createAuditedApprovalChain` 包装层把 asked/decided 事件落盘会话日志（编排层 command/write/plan 审批的审计通道）。
- turn/step 两级循环 `runTurn`；含 max_tokens 截断防御与 abort 落盘语义。
- 配置加载 `loadSettings`（双层：用户级 `~/.hotpot/settings.json` 必填，含三档模型与凭证；项目级 `.hotpot/settings.json` 自 cwd 向上查找、可选，只覆盖非凭证白名单字段；zod 校验，apiKey 支持 `$ENV` 引用且仅用户级）。

当前状态：会话事件日志（`src/session/`，含 `resumeSession` 续聊恢复）、section 注册表（`src/prompt/`）、工具框架与审批链（`src/tools/`、`src/approval/`，含 bash/read/write/edit）、turn/step 循环 `runTurn`（`src/agent/`）、配置加载 `loadSettings`（`src/config.ts`）已完成；`src/index.ts` 为包入口（仅 re-export）。M2 增补：assistant_msg 落盘 tier/model、tool_result 归属 agentId（derive 按 agent 过滤）、审批 asked/decided 落盘、`pollInbox` step 顶部注入钩子。架构依据：`docs/archive/02-architecture.md`。
