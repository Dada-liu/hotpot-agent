# 三层编排

编排层把一次用户消息组织成 main → worker → task 三层 agent 结构：主 agent 负责理解与决策，worker 负责执行与并行拆分，task 是最小原子任务单元。

## 三层职责

| 层 | 职责 | 模型档位 |
|----|------|----------|
| main | 对话入口；首轮提示词判定难度并路由；需要时产出 plan | 默认 high（`mainAgentTier` 可调） |
| worker | 接受任务、执行工具、可拆出并行 task；结果摘要回 main | 按任务难度路由 |
| task | 原子任务，继承所属 worker 的档位 | 继承 worker |

路由没有独立工具：main 在**首轮提示词**里完成难度判定——trivial 直接回答、simple 首轮 spawn worker 内联执行、complex 首轮产出计划等审批。

## plan 先审后执行

复杂任务首轮产出 plan 全文，经用户审批后才执行：

- 批准前**没有任何文件改动**（fail-closed）。
- 用户可批注，plan 进入修订循环，上限 `planMaxRevisions` 轮（默认 3）。
- CLI 里就地审阅（y / n / 批注）；Web 端以 plan 卡片展示并就地审批。
- `plan/denied` 会记为计划被拒，进入遥测 outcome。

## 并行拆分

worker 可把任务拆给多个 task 并行执行（默认上限 `maxParallelTasks = 10`）。验收基线：8 个只读审查任务并行时，总耗时明显低于串行。子 agent 失败时 worker 负责重试或上报，不会静默丢失。

## steer / queue 双队列

回合进行中可以持续干预，两个队列语义不同：

- **steer（next-step）**：在**当前回合**的下一个 step 顶部注入模型历史，用于回合中纠偏。
- **queue（next-turn）**：排入**下一个回合**，当前回合结束后按序补发为新用户消息。

Ctrl-C 同时 abort 当前回合的 AbortController 与队列消费。队列快照经 `GET /api/sessions/:id/inbox` 暴露给 Web 端展示。

## 上下文与记账

- worker / task 的上下文与 main 隔离，结果以摘要形式回传，避免长任务撑爆 main 的上下文窗口。
- 分层 usage 记账按 `agentId + tier` 统计，每个 step 的 `assistant_msg.usage` 都会进会话日志；遥测在 turn 结束时折叠整棵 agent 树（见[遥测](/advanced/telemetry)）。

## 效果验证

M2 验收标准（见仓库 `docs/archive/04-roadmap.md`）：

1. simple 任务（如「改一下 readme 标题」）不出现 plan 审批，token 消耗与无编排基线同量级（偏差 < 20%）。
2. complex 任务必须先展示 plan，批准前无任何文件改动。
3. 并行审查任务总耗时明显低于串行。
4. 路由可观测：simple 任务被路由到 medium/low 档时，usage 事件里的 tier 字段正确。
