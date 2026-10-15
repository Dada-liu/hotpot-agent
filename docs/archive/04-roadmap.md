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

范围：
- packages/server：REST + SSE、会话管理、断线重连从日志补发
- packages/web：会话列表、流式对话、工具调用卡片、plan 审查面板、用量展示

验收标准：
1. web 端走完 M1/M2 的全部验收场景
2. 断网重连后 SSE 恢复，事件不丢
3. 审批操作在 web 端完成，CLI 与 web 可同时观察同一会话

## M4 扩展功能

**目标**：按优先级逐个落地，每完成一个功能跑一次回归。

参考 pi/dsh 后调整的功能清单（排序 = 建议实施顺序）：

| # | 功能 | 说明 | 来源/依据 |
|---|------|------|-----------|
| 1 | todo 工具 | 全量替换语义的任务清单（dsh `tool-todo` 同款），长任务成功率收益最直接 | dsh |
| 2 | steer / queue 完善 | M2 已有队列 API，本步完成 web 端交互（排队展示、steer 注入、中断） | dsh/pi |
| 3 | hooks | 生命周期钩子链：session_start、pre/post tool、turn_end（审批 waterfall 的公开版）；兼容 Claude Code 钩子配置格式可选 | dsh |
| 4 | skill 支持 | SKILL.md + frontmatter；启动只注入 name+description+路径，模型按需 read 加载（渐进式，省 token） | pi |
| 5 | prompt templates | `prompts/*.md` 变成 `/命令`，支持参数占位；自定义命令入口 | pi |
| 6 | web_search / web_fetch 工具 | 自媒体运营 bench 需要联网能力；搜索后端可换 | dsh |
| 7 | MCP 支持 | stdio + streamable HTTP client；工具桥接为 `mcp__<server>__<tool>` | pi/dsh 一致 |
| 8 | 上下文自动压缩 | compaction 作为会话事件（记录保留点 + 摘要），恢复时跳过被压缩段（pi 手法）；M1 遗留项 | pi/dsh |
| 9 | 用户记忆 | 跨会话记忆，启动时注入摘要 section，写记忆走独立工具 | — |
| 10 | 向量数据库 | 服务记忆与代码检索，独立 packages/memory | — |
| 11 | 后台任务 jobs | 后台 bash、子 agent 后台运行，完成时通知 | dsh |
| 12 | 权限预设 | sandbox/approval 旋钮打包成预设（safe / default / yolo） | dsh |
| 13 | tool_search 延迟工具加载 | 工具多时先给目录、按需加载声明，省 token | pi |
| 14 | 沙箱 | 审批链上的执行器替换；本地 Seatbelt/容器 | — |

每项验收：功能自身可用 + 新增事件类型纳入 JSONL v1 规范 + 遥测能看到该功能的开关与用量。

相对 PRD 的变更说明：新增 #3 hooks、#5 prompt templates、#6 web 工具、#11 jobs、#12 权限预设、#13 tool_search（均来自 pi/dsh 调研）；其余为 PRD 原有项重排。

## M5 配套体系

范围：
- 测试补齐：集成测试覆盖主要 agent 场景（mock LLM 录制回放）
- benchmarks：SWE-bench 跑通；自建 bench 金融/软件开发/自媒体运营**各先出 1 题打底**（已确认，出题人：设计者），后续从日常使用本 agent 的历史任务中沉淀新题
- 遥测：token/耗时/工具成功率/任务成功率，本地存储 + 导出报表

验收标准：
1. benchmark 一键运行，输出成功率与平均 token 成本报告
2. 遥测报表能回答「上周每个任务平均花了多少 token、成功率多少」
3. 自建 bench 有从历史会话沉淀新题的流程文档（筛选 → 脱敏 → 题目化）

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
