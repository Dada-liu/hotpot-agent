# 04 里程碑与实施计划

> 原则：每个里程碑结束都有可运行的交付物，能真实演示，不是半成品堆叠。
> M4 功能清单已参考 pi 与 dsh 调研结果调整（见 M4 节末尾说明）。

## M1 最小可用闭环

**目标**：终端里跑通「对话 → 工具调用 → 完成任务」全流程。**只做 CLI**（已确认），不做 web。

范围：
- packages/ai：统一接口 + anthropic-messages 协议 + openai-completions 协议；模型元数据常量（手写少量）
- packages/core：turn/step 两级循环、append-only JSONL 事件日志 + deriveMessages、系统提示词 section 注册表、bash/read/write/edit 四工具（审批 waterfall + 高危确认）
- packages/cli：行式对话入口，恢复会话
- 配置：`~/.hotpot/settings.json`（三档模型必填）

验收标准：
1. CLI 中完成任务「找出 src 下所有 .ts 文件，统计行数写入 report.txt」，agent 自主多步调用工具完成
2. kill 进程后用同一会话重启，从 JSONL 折叠恢复，能继续对话
3. `pnpm test` 全绿（ai 适配器用录制回放 mock，不依赖真实 API）

## M2 三层编排 + human-in-the-loop

**目标**：主/从/子三层结构可用，复杂任务先 plan 后执行，分层模型路由生效。

范围：
- packages/orchestrator：MainAgent / WorkerAgent / TaskAgent、难度评估 + modelTier 路由、并行调度（上限 10，可配）
- plan 生成与审批流（CLI 内审批，修订上限 3，可配）
- 上下文隔离与摘要回传
- 分层 usage 记账（按 agentId + tier）
- steer/queue 双队列 API（含 `inbox/spliced` 事件落盘），CLI 内最小可用

验收标准：
1. simple 任务（如「改一下 readme 标题」）不出现 plan 审批，token 消耗与 M1 同量级（偏差 < 20%）
2. complex 任务（如「加一个 CLI 子命令」）必须先展示 plan，批准前无任何文件改动
3. 8 个只读审查任务触发并行 TaskAgent，总耗时明显低于串行
4. 分层路由可观测：simple 任务被路由到 medium/low 档时，usage 事件里的 tier 字段正确
5. 子 agent 失败时 WorkerAgent 能重试或上报，不会静默丢失

## M3 Web 端

**目标**：浏览器完成全部操作。

**状态：已完成（M3 收口提交 78096b6）。**

范围：
- packages/server：REST + SSE、会话管理、断线重连从日志补发（已完成，测试见 `packages/server/test/api.test.ts`、`session-manager.test.ts`、`tailer.test.ts`）
- packages/web：会话列表、流式对话、工具调用卡片、plan 审查面板、用量展示（已完成，测试见 `packages/web/test/`）

验收标准：
1. web 端走完 M1/M2 的全部验收场景（已完成（M3 收口提交 78096b6），测试依据：`packages/server/test/session-manager.test.ts` 与 `api.test.ts` 以 scriptedAdapter 回放 simple/complex/审批/并行子任务/steer/cancel 场景，`packages/web/test/` 覆盖 reducer 与 markdown，`packages/orchestrator/test/` 覆盖编排场景）
2. 断网重连后 SSE 恢复，事件不丢（已完成（M3 收口提交 78096b6），测试依据：`packages/server/test/tailer.test.ts` 钉住字节偏移续读，`api.test.ts` 钉住 `Last-Event-ID` 重连补发不丢序）
3. 审批操作在 web 端完成，CLI 与 web 可同时观察同一会话（已完成（M3 收口提交 78096b6），测试依据：`packages/server/test/session-manager.test.ts` 审批桥全流程，`tailer.test.ts` 全量推送 durable 事件）

## M4 扩展功能

**目标**：按优先级逐个落地，每完成一个功能跑一次回归。

参考 pi/dsh 后调整的功能清单（排序 = 建议实施顺序）：

| # | 功能 | 说明 | 来源/依据 | 状态 |
|---|------|------|-----------|------|
| 1 | todo 工具 | 全量替换语义的任务清单（dsh `tool-todo` 同款），长任务成功率收益最直接 | dsh | ✅ 已实现：`core/src/tools/todo.ts`、`core/src/session/todos.ts`；验收 `core/test/todo.test.ts`、`orchestrator/test/todo-flow.test.ts` |
| 2 | steer / queue 完善 | M2 已有队列 API，本步完成 web 端交互（排队展示、steer 注入、中断） | dsh/pi | ✅ 已实现：`GET /api/sessions/:id/inbox`、web 队列条（`web/src/components/ChatView.tsx`）；验收 `orchestrator/test/inbox.test.ts`、`server/test/api.test.ts`、`web/test/reducer.test.ts` |
| 3 | hooks | 生命周期钩子链：session_start、pre/post tool、turn_end（审批 waterfall 的公开版）；兼容 Claude Code 钩子配置格式可选 | dsh | ✅ 已实现：`core/src/hooks/hooks.ts`（Claude Code 格式）；验收 `core/test/hooks.test.ts`、`core/test/loop.test.ts`、`orchestrator/test/hooks.test.ts` |
| 4 | skill 支持 | SKILL.md + frontmatter；启动只注入 name+description+路径，模型按需 read 加载（渐进式，省 token） | pi | ✅ 已实现：`core/src/skills/skills.ts` + read 追踪；验收 `core/test/skills.test.ts`、`orchestrator/test/skills.test.ts` |
| 5 | prompt templates | `prompts/*.md` 变成 `/命令`，支持参数占位；自定义命令入口 | pi | ✅ 已实现：`core/src/prompt-templates/prompt-templates.ts`、CLI 展开、server 统一展开、web `/` 补全；验收 `core/test/prompt-templates.test.ts`、`server/test/api.test.ts`、`cli/test/cli.test.ts` |
| 6 | web_search / web_fetch 工具 | 自媒体运营 bench 需要联网能力；搜索后端可换 | dsh | ✅ 已实现：`core/src/tools/web-fetch.ts`、`core/src/tools/web-search.ts`；验收 `core/test/web-fetch.test.ts`、`core/test/web-search.test.ts` |
| 7 | MCP 支持 | stdio + streamable HTTP client；工具桥接为 `mcp__<server>__<tool>` | pi/dsh 一致 | ✅ 已实现：`orchestrator/src/mcp/mcp.ts` + `orchestrator/src/json-schema-to-zod/json-schema-to-zod.ts`；验收 `orchestrator/test/mcp.test.ts`、`json-schema-to-zod.test.ts`；真实 server 冒烟步骤见 `orchestrator/README.md` |
| 8 | 上下文自动压缩 | compaction 作为会话事件（记录保留点 + 摘要），恢复时跳过被压缩段（pi 手法）；M1 遗留项 | pi/dsh | ⏳ 未开始 |
| 9 | 用户记忆 | 跨会话记忆，启动时注入摘要 section，写记忆走独立工具 | — | ⏳ 未开始 |
| 10 | 向量数据库 | 服务记忆与代码检索，独立 packages/memory | — | ⏳ 未开始 |
| 11 | 后台任务 jobs | 后台 bash、子 agent 后台运行，完成时通知 | dsh | ⏳ 未开始 |
| 12 | 权限预设 | sandbox/approval 旋钮打包成预设（safe / default / yolo） | dsh | ⏳ 未开始 |
| 13 | tool_search 延迟工具加载 | 工具多时先给目录、按需加载声明，省 token | pi | ⏳ 未开始 |
| 14 | 沙箱 | 审批链上的执行器替换；本地 Seatbelt/容器 | — | ⏳ 未开始 |

每项验收：功能自身可用 + 新增事件类型纳入 JSONL v1 规范 + 遥测能看到该功能的开关与用量。

相对 PRD 的变更说明：新增 #3 hooks、#5 prompt templates、#6 web 工具、#11 jobs、#12 权限预设、#13 tool_search（均来自 pi/dsh 调研）；其余为 PRD 原有项重排。

## M5 配套体系

M5 拆成两条独立工作流：工具侧遥测客户端（M5.1，本仓库，已完成）与遥测后台 / benchmarks（独立工作流，另行推进）。

原 M5 范围中的「测试补齐：集成测试覆盖主要 agent 场景（mock LLM 录制回放）」没有取消：沿用「测试随功能走」的持续补测策略，随每个里程碑补充，不单独堆到 M5 收尾；当前全量为 52 个测试文件 / 492 条用例。

### M5.1 遥测客户端（已完成）

范围（已实现）：

- `packages/telemetry`：事件 schema v1（九类事件严格白名单）、错误消息脱敏、匿名安装 ID、内存队列 + 批量 POST + 指数退避、turn 采集器、cli/server 共用 runtime
- `packages/core/src/config/config.ts`：用户级 `telemetry` 配置（`enabled` / `endpoint` / `token` / `flushIntervalMs`），项目级不接受
- `packages/cli`、`packages/server`：会话生命周期与每个 turn 的旁路接入
- 数据边界：只上报匿名指标与脱敏后的错误；不采集 prompt/回复、工具入参/输出、文件内容、文件路径、命令、URL 查询参数、用户名、仓库名（详见 `packages/telemetry/README.md`）

验收证据：

- `packages/telemetry/test/`：schema 4 条、脱敏 6 条、客户端 9 条、安装 ID 7 条、采集器 18 条（turn 折叠、worker/task 用量、outcome 判定、feature 计数、损坏日志、会话生命周期）
- `packages/cli/test/telemetry.test.ts`（4 条）：每个 turn 上报匿名批次且 payload 不含对话文本；`enabled=false`、未配置 endpoint（测试直接注入 settings，绕过 schema）、非法 endpoint 均不发请求
- `packages/server/test/telemetry.test.ts`（4 条）：`turn_end` 含 worker 用量、`close(id)` 上报 `session_end`、`attachById` 上报 `session_start(resumed: true)`、禁用与未配置 endpoint 不发请求
- 全量 `pnpm typecheck`、`pnpm test`、`pnpm exec biome check .` 通过

### 仍未开始（独立工作流）

- M5.2 遥测后台：仓库外 `../hotpot-telemetry/`（ingest + SQLite + 聚合 API + 管理界面 + 邮件/webhook/飞书告警），部署在 `sell_system`，不打进 CLI/server 构建产物
- M5.3 / M5.4 benchmark runner 与官方评测：`packages/benchmarks`、SWE-bench Lite 10 题、`swebench` harness + Docker

两者与 M5.1 解耦：客户端只约定 ingest 的 HTTP 契约（`POST <endpoint>/api/v1/ingest`，`schemaVersion = 1`，`kind` 区分 `user`/`benchmark`）。

验收标准（保持原目标）：

1. benchmark 一键运行，输出成功率与平均 token 成本报告（依赖 M5.3/M5.4）
2. 遥测报表能回答「上周每个任务平均花了多少 token、成功率多少」（依赖 M5.2）
3. 自建 bench 有从历史会话沉淀新题的流程文档（筛选 → 脱敏 → 题目化）（依赖 M5.3）

## 依赖关系

```
M1 ──> M2 ──> M3 ──> M4 ──> M5
  │              │
  └── 测试从 M1 起持续编写（随功能走，不堆到最后）
      benchmark 题目沉淀流程在 M2 之后开始积累语料，不等 M5
```

## 已确认决议记录

| 问题 | 决议 |
|------|------|
| M1 范围 | 只做 CLI |
| M4 功能集 | 参考 pi/dsh 调研调整为上表 14 项，按表内顺序实施 |
| 自建 benchmark 题目 | 三个领域各先出 1 题，后续从使用历史沉淀 |
