# 首轮流路由：删除 delegate 工具

- 日期：2026-10-21
- 状态：已合入 main（`72e4500`，工作分支 `b3418cc..72e4500`）

## 背景与动机

原设计里 main agent 通过 `delegate` 工具把复杂任务委派给一个规划子 agent。实测「在 temp/ 下新建收银系统」任务暴露链路冗余：main 首轮调用 delegate（复述整个任务 ~1.3k output tokens），子 agent 只返回一句「请自己写计划」，main 第二轮才把计划写出来——委派一跳没有产生价值，反而多一次完整 LLM 往返。

## 变更内容

- **删除 delegate 工具**（`packages/orchestrator/src/tools/delegate.ts`），`TurnState` 从 runtime 迁移到 types。
- **首轮流提示词路由**：main agent 首轮直接按难度分流——trivial 直接回答不调用工具；simple 直接 `spawn_workers`；complex 首轮直接输出 `# Plan`（Plan / Steps / Files / Acceptance criteria 三段）。
- **plan.ts 新增 `detectPlanDraft(runtime, afterId?)`**：锚定本回合 user_msg 事件扫描窗口，识别首轮计划草稿；turn 内 steer 注入的消息不会把首轮计划挤出检测窗口。
- **spawn_workers 门禁**：计划未批准时调用，若窗口内无计划标记则 isError 拒绝；已批准则放行。
- 测试 rework（orchestrator/server/cli/benchmarks 四个包），README 与 AGENTS.md 中英文同步。

## 影响面

- `packages/orchestrator`：main-turn、plan/、tools/spawn-workers.ts、prompts/。
- agent 对外行为：complex 任务的首轮响应从「工具调用」变为「计划文本」；审批交互减少（实测 approval 8 次 → 4 次）。
- 无兼容性保留：旧会话不迁移，新行为从合入起生效。

## 验证

- 573/573（后 574/574）测试全绿；`pnpm typecheck` 与 biome 干净（注：`scanWindowStart` 的 `e.id` 访问在合入时漏跑 typecheck，后于 2026-10-21 以 `"id" in e` 收窄修复）。
- custom benchmark 同机同配置 A/B（benchmark 迁移至根级前在 `packages/benchmarks` 下测）：平均耗时 22.2s → 13.1s（**-41%**），平均 output tokens -9%，通过率 3/3 不变。
- 收银系统真实任务前后对比：总 tokens -82%（4.52M → 0.81M），其中含一次 worker 故障方差，非全部归因于本变更。

## 相关链接

- 提交区间：`9674e36`（plan 模板与 detectPlanDraft）→ `86a6ada`（删 delegate）→ `c4c792f`（首轮流改造）→ `786340a`（测试 rework）→ `9b52264`（文档）→ `72e4500`（锚定修复 + final review）。
- 关键文件：`packages/orchestrator/src/main-turn/main-turn.ts`、`plan/plan.ts`、`tools/spawn-workers.ts`、`prompts/prompts.ts`。
