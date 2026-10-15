# M2 三层编排 + human-in-the-loop 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 docs/archive/03 文档定义的三层 agent 编排（MainAgent/WorkerAgent/TaskAgent）、plan 审批流、分层模型路由与 steer/queue 双队列，通过 M2 全部 5 条验收标准。

**Architecture:** 新增 `packages/orchestrator` 包：它持有 `OrchestrationRuntime`（会话、按档位解析模型、审批链、spawn 落盘），按角色装配系统提示词与工具集，通过**元工具内联执行**驱动下层 agent——`delegate` 的 execute 直接 spawn WorkerAgent 并跑完其 turn 再返回摘要；complex 走编排器驱动的 plan 阶段（起草→审批→修订循环→执行），比工具驱动更确定性、结构上保证「批准前零文件改动」。下层 agent 复用 core 的 `runTurn`（agentId 区分写同一 JSONL），摘要按 03 文档 §5 取子 agent 最后一条 assistant 消息。

**Tech Stack:** Node ≥22 TS（erasable-syntax-only）、zod、vitest、`@hotpot/ai` 的 `scriptedAdapter` 回放测试。

**Spec:** `docs/archive/03-agent-orchestration.md`、`docs/archive/04-roadmap.md` M2 节（验收标准以 04 文档为准）。

## Global Constraints

- TS 仅 erasable syntax（禁 enum/namespace/参数属性），源码内 import 带 `.ts` 后缀，禁 inline import
- 代码注释与 README 用简体中文；LLM 系统提示词用英文（配中文注释）
- 无 `any`；zod v4；测试从根目录 `pnpm test`（vitest run）；每任务跑 `pnpm check`（biome）
- 配置只加白名单字段消费：`maxParallelTasks` 默认 10、`planMaxRevisions` 默认 3（config.ts schema 已有，本计划只加消费者）
- 事件格式 v1 已定稿（events.ts 已含 `agent_spawn`/`approval/*`/`inbox/spliced` 变体）：M2 只实现生产者，不改已有变体语义；唯一允许的类型修补：`tool_result` 增加可选 `agentId`（旧日志缺省视为 `"main"`）、`approval/decided` 增加可选 `note`
- 依赖方向 cli → orchestrator → core → ai，禁止反向
- 提交信息用中文、conventional 前缀（如 `feat(core): ...`），不带 emoji

## 计划级决策（对 spec 有意的裁剪，均记录于此）

1. **不实现 `request_approval` / `report_result` 工具**（03 文档 §6 表）。理由：plan 审批由编排器直接驱动（对应 §3 流程图的 asked/decided 事件对，确定性更高、修订计数在代码里）；结果回传按 §5 用「最后一条 assistant 消息」即可，YAGNI。
2. **plan 修订语义**：`planMaxRevisions=3` = 最多 3 次批注修订；第 4 次起草后不再询问用户，直接 `revision_exhausted` 结束 turn。测试钉死这个语义。
3. **Worker/Task 执行期间事件不透出 CLI**（tool execute 内联跑下层 turn）：M2 CLI 最小可用，用户看到 `[tool] delegate(...)` 与最终摘要；全过程仍在 JSONL 落盘，M3 的 SSE 可回放补齐。
4. **主 agent 工具集 = delegate + spawn_workers**（03 文档 §1）；worker = 四基础工具 + spawn_tasks；task = 四基础工具。`spawn_workers` 带 `planApproved` 守卫，未批准的 complex turn 调用返回 isError。

## Review Focus

1. 同一 JSONL 被多 agent **并发 append**（8 个并行 TaskAgent）是否交错损坏——Task 1 并发写测试钉死。
2. **M1 旧会话恢复**：tool_result 无 agentId 字段的历史日志，derive 须按 `"main"` 处理——Task 1 兼容测试。
3. **plan 批准前零文件改动**：主 agent 起草期重入 delegate、未批准调 spawn_workers，都必须被结构性挡住——Task 8 守卫测试。
4. **AbortSignal 贯穿三层**：cancel/中断在 worker/task 执行中到达，子进程与下层 turn 都要停——Task 9、Task 11 测试。
5. **下层结果不串上下文**：worker 的 tool_result 不得进 main 的 derive 历史（agentId 过滤）——Task 1 过滤测试。

---

### Task 1: core — tool_result 归属 agentId + derive 过滤 + 并发 append 安全

**Files:**
- Modify: `packages/core/src/session/events.ts`（tool_result 变体加 `agentId?: string`）
- Modify: `packages/core/src/agent/loop.ts`（persistToolResult 写入 `agentId: cfg.agentId`）
- Modify: `packages/core/src/session/derive.ts`（tool_result 按 `e.agentId ?? "main"` 过滤）
- Modify: `packages/core/src/session/store.ts`（确认 append 用 O_APPEND；否则改）
- Test: `packages/core/test/session.test.ts`、`packages/core/test/derive-multi-agent.test.ts`（新建）

**Interfaces:**
- Produces: `SessionEvent` 的 tool_result 变体含可选 `agentId`；`deriveMessages(events, agentId)` 对 tool_result 按 agent 过滤（其余不变）；`Session.append` 并发调用安全。

- [ ] **Step 1: 写失败测试**

`derive-multi-agent.test.ts` 三个用例：
- `deriveMessages` 过滤 tool_result：构造事件序列（main 的 user/assistant/tool_result + worker-1 的 user/assistant/tool_result 交错），断言 `deriveMessages(events, "main")` 只含 main 的 tool_result 块、且与 main assistant 的 tool_call 配对后连续 tool_result 仍合并为单条 user 消息
- 兼容：tool_result 无 agentId 时视为 `"main"`
- 并发 append：`createSession` 后 `Promise.all` 8 个 `append(tool_result)`，`loadSession` 读回 8+1 行、逐行 JSON.parse 成功且内容完整

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/derive-multi-agent.test.ts`（根目录）
Expected: FAIL（agentId 过滤未实现 / 新文件无对应实现）

- [ ] **Step 3: 实现**

events.ts tool_result 变体加 `agentId?: string`（带中文注释说明缺省 "main" 的兼容语义）；loop.ts persistToolResult 落盘时写 `agentId: cfg.agentId`；derive.ts 过滤 `(e.agentId ?? "main") === agentId`；store.ts 确认 append 每次以 `fs.appendFile`（O_APPEND 语义）单行写入，若不是则改为打开时带 `a` 标志。修既有测试中断言 tool_result 形状的地方。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿（含既有 session.test.ts）

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): tool_result 归属 agentId，derive 按 agent 过滤，并发 append 安全"
```

---

### Task 2: core — runTurn 记录真实 tier + next-step inbox 注入钩子

**Files:**
- Modify: `packages/core/src/agent/types.ts`（LoopConfig 加 `tier?: ModelTier`、`pollInbox?: () => Promise<string[]>`）
- Modify: `packages/core/src/agent/loop.ts`（assistant_msg 用 `cfg.tier ?? "high"`；step 边界调 pollInbox，每条消息 append `user_msg`（agentId=cfg.agentId）后再 derive）
- Test: `packages/core/test/loop.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 append/derive
- Produces: `LoopConfig.tier?: ModelTier`（缺省 `"high"`）；`LoopConfig.pollInbox?: () => Promise<string[]>`——返回的字符串在下一 step 前作为 `user_msg` 事件落盘并进入模型历史；assistant_msg 事件 `tier` 字段反映 `cfg.tier`。

- [ ] **Step 1: 写失败测试**

loop.test.ts 追加两例（用 scriptedAdapter + recording 包装，沿用文件内既有模式）：
- `tier` 透传：LoopConfig 传 `tier: "low"`，断言落盘 assistant_msg 事件 `tier === "low"`；不传时 `"high"`
- inbox 注入：script 两次调用；第一次 `finish: tool_calls`（带一个 isConcurrencySafe 的读工具调用）或直接 `finish: stop` 后再来一次——选更简单的：`pollInbox` 第 1 次调用返回 `["请停止"]`、之后返回 `[]`；脚本第二次调用返回 `finish: stop`；断言第二次请求的 messages 里出现该 user 文本、且会话里落了对应 `user_msg` 事件

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/loop.test.ts`
Expected: FAIL（tier 仍硬编码 "high" / pollInbox 不存在）

- [ ] **Step 3: 实现**

loop.ts：assistant_msg 的 `tier: cfg.tier ?? "high"`；`while` 循环顶部（derive 之前）若 `cfg.pollInbox` 存在则 `await` 取出消息，逐条 append `user_msg`（复用与外部 user_msg 相同的形状）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): runTurn 记录真实 tier 并支持 next-step 消息注入"
```

---

### Task 3: core — 审批审计落盘 + index 导出补齐

**Files:**
- Create: `packages/core/src/approval/audit.ts`
- Modify: `packages/core/src/session/events.ts`（approval/decided 加 `note?: string`）
- Modify: `packages/core/src/index.ts`（导出 approval/audit、prompt sections、session 事件类型中 orchestrator 需要的全部成员）
- Test: `packages/core/test/approval-audit.test.ts`（新建）

**Interfaces:**
- Produces: `createAuditedApprovalChain(inner: ApprovalChain, opts: { session: Session; agentId: string }): ApprovalChain`——`ask()` 先 append `approval/asked`（id=randomUUID，payload 含 kind/summary/detail），再委托 inner.ask，最后 append `approval/decided`（requestId=asked 的 id，decision 映射 allow→approved/deny→denied，可带 note）；core index 导出 `ApprovalChain`、`ApprovalRequest`、`ApprovalDecision`、`createAuditedApprovalChain`、`PromptSection`、`PromptContext`、`registerSection`、`resetSections`、`buildSystemPrompt`、`registerDefaultSections`、`ModelTier`、`InboxQueue`、`InboxMessage` 及全部 SessionEvent 类型。

- [ ] **Step 1: 写失败测试**

approval-audit.test.ts：
- ask 一路放行：断言落盘事件序 `[approval/asked, approval/decided]`，asked.payload.kind/summary/detail 与请求一致，decided.requestId === asked.id、decision === "approved"
- inner deny：decision === "denied"
- agentId：两个事件都带传入的 agentId

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/core/test/approval-audit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

audit.ts 按 Interfaces 实现（chain 仍是纯委托，落盘在包装层）；events.ts decided 变体加可选 `note?: string`；index.ts 补导出（注意现有导出风格，纯 re-export）。

- [ ] **Step 4: 跑测试确认通过 + biome**

Run: `pnpm test && pnpm check`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): 审批 asked/decided 事件落盘与导出补齐"
```

---

### Task 4: orchestrator — 包脚手架

**Files:**
- Create: `packages/orchestrator/package.json`、`AGENTS.md`（英文，参照 packages/core/AGENTS.md 风格）、`README.md`（简体中文）、`src/index.ts`（先空 re-export）、`test/smoke.test.ts`（1+1）

**Interfaces:**
- Produces: 包名 `@hotpot/orchestrator`，`private: true`、`type: module`，deps：`@hotpot/ai: workspace:*`、`@hotpot/core: workspace:*`；根 `pnpm test` 自动收录（vitest include 已是 `packages/*/test/**`）。

- [ ] **Step 1: 建包与冒烟测试**

按 packages/core/package.json 的字段风格写 package.json；README.md 用简体中文写「本包做什么」（三层编排：主/从/子 agent、plan 审批、steer/queue）；AGENTS.md 用英文写开发约定（依赖方向、测试命令）。

- [ ] **Step 2: 验证**

Run: `pnpm install && pnpm test`
Expected: install 成功、冒烟测试通过

- [ ] **Step 3: 提交**

```bash
git add packages/orchestrator pnpm-lock.yaml
git commit -m "feat(orchestrator): M2 包脚手架"
```

---

### Task 5: orchestrator — runtime、spawn 与档位模型解析

**Files:**
- Create: `packages/orchestrator/src/types.ts`（`AgentRole`、`OrchestrationEvent`）
- Create: `packages/orchestrator/src/models.ts`（从 cli 迁移 `resolveModelAdapter` 逻辑并泛化）
- Create: `packages/orchestrator/src/runtime.ts`
- Modify: `packages/cli/src/chat.ts`（改为引用 orchestrator 的 resolveModel，见 Interfaces）
- Test: `packages/orchestrator/test/runtime.test.ts`（新建）

**Interfaces:**
- Consumes: core 的 `Session`、`ApprovalChain`、`ModelTier`、`LlmAdapter`、`ModelInfo`（Task 3 导出）
- Produces:
  ```ts
  export type AgentRole = "main" | "worker" | "task";
  export type OrchestrationEvent =
    | AgentEvent
    | { type: "agent_spawn"; agentId: string; role: AgentRole; tier: ModelTier; task: string }
    | { type: "plan"; phase: "drafted" | "approved" | "denied" | "revision_exhausted"; plan?: string };
  export interface ModelResolution { adapter: LlmAdapter; model: ModelInfo; apiKey: string; baseUrl?: string }
  export function resolveModel(ref: { provider: string; model: string; apiKey: string; baseUrl?: string }): ModelResolution
  export interface OrchestrationRuntime {
    readonly session: Session; readonly cwd: string; readonly approval: ApprovalChain;
    readonly maxParallelTasks: number; readonly planMaxRevisions: number;
    resolveModel(tier: ModelTier): ModelResolution;
    spawn(opts: { role: AgentRole; parentAgentId: string; task: string; tier: ModelTier }): Promise<{ agentId: string }>;
  }
  export function createRuntime(opts: {
    session: Session; cwd: string; approval: ApprovalChain;
    models: Settings["models"]; maxParallelTasks?: number; planMaxRevisions?: number;
  }): OrchestrationRuntime
  ```
  spawn 落盘 `agent_spawn`（id/ts/parentAgentId/agentId/role/task/tier），agentId 规则：`worker-1`、`task-1`…按 role 各起计数，同会话内唯一；`resolveModel` 未命中目录时按 provider 推断协议（保留 cli 现有 warning 行为）。

- [ ] **Step 1: 写失败测试**

runtime.test.ts：
- `spawn` 落盘 agent_spawn 事件，字段完整、agentId 为 `worker-1`/`task-1`；同 role 二次 spawn 编号递增
- `resolveModel("low")` 返回 low 档配置对应的 model id 与适配器；目录外 provider 推断协议且不抛错
- `maxParallelTasks`/`planMaxRevisions` 缺省 10/3

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/orchestrator/test/runtime.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

types.ts/models.ts/runtime.ts 按 Interfaces；chat.ts 的 `resolveModelAdapter` 删除、改为 import orchestrator 的 `resolveModel`（chat.ts 后续 Task 11 还会大改，本步只做等价迁移，保持 cli 测试绿）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿（cli 既有测试等价通过）

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator packages/cli
git commit -m "feat(orchestrator): runtime、agent_spawn 落盘与档位模型解析"
```

---

### Task 6: orchestrator — 角色提示词与按角色工具集

**Files:**
- Create: `packages/orchestrator/src/prompts.ts`（英文 prompt + 中文注释）
- Create: `packages/orchestrator/src/registries.ts`
- Test: `packages/orchestrator/test/registries.test.ts`（新建）

**Interfaces:**
- Consumes: core `createToolRegistry`、`ToolDefinition`、`buildSystemPrompt`；tools 四件套与 Task 7 的两个元工具
- Produces:
  ```ts
  export function buildRoleSystemPrompt(role: AgentRole, ctx: { cwd: string; os: string; date: string; tools: ToolDeclaration[] }): string
  export function createRoleRegistry(role: AgentRole, metaTools: ToolDefinition<unknown>[]): ToolRegistry
  ```
  规则（钉进测试）：main = metaTools（delegate、spawn_workers）无文件工具；worker = bash/read/write/edit + spawn_tasks；task = bash/read/write/edit。prompts.ts 三个角色的英文指令要点——main：难度判定规则（引用 03 文档 §2 的 simple/complex 边界示例）、trivial 直接答、complex 先给 plan；worker：执行派发的任务、可并行则 spawn_tasks（引用 §4 的三条件与正反例）、收尾给结构化摘要（做了什么/关键文件/问题/验证）；task：只完成原子任务，输出结果摘要。

- [ ] **Step 1: 写失败测试**

registries.test.ts：按角色断言 registry 内工具名集合精确相等；断言 prompt 含关键指令短语（如 main 的 "difficulty"、worker 的 "parallel"）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/orchestrator/test/registries.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

prompts.ts 用 core 的 `buildSystemPrompt` + 各角色注册段实现（英文段内容，段内附中文注释说明设计意图）；registries.ts 用 core 四工具与传入 metaTools 装配。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): 角色系统提示词与按角色工具集"
```

---

### Task 7: orchestrator — delegate 工具 + runMainTurn 骨架（trivial/simple 流）

**Files:**
- Create: `packages/orchestrator/src/tools/delegate.ts`
- Create: `packages/orchestrator/src/main-turn.ts`
- Modify: `packages/orchestrator/src/index.ts`（导出 runMainTurn 等）
- Test: `packages/orchestrator/test/main-turn.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  export interface DelegateArgs { difficulty: "trivial" | "simple" | "complex"; modelTier: ModelTier; task: string; reason?: string }
  export interface TurnState { phase: "initial" | "planning" | "executing"; planApproved: boolean; revisions: number; lastDelegate?: DelegateArgs }
  export function createDelegateTool(runtime: OrchestrationRuntime, state: TurnState): ToolDefinition<DelegateArgs>
  export async function* runMainTurn(opts: {
    runtime: OrchestrationRuntime; userMessage: string; signal: AbortSignal;
    mainTier: ModelTier; onPlanApproval?: (plan: string) => Promise<PlanDecision>;
  }): AsyncIterable<OrchestrationEvent>
  export type PlanDecision = { kind: "approve" } | { kind: "reject"; note: string } | { kind: "annotate"; note: string };
  ```
  delegate execute 语义：difficulty=trivial → 返回提示文本「直接回答用户」；simple → `runtime.spawn({role:"worker",...})` + 内联跑 worker turn（append user_msg(agentId=worker) 任务描述 → runTurn，tier/model 用 runtime.resolveModel(modelTier)）→ content = `Worker ${agentId} (tier=${modelTier}) result:\n${summary}`，summary = 该 worker 最后一条 assistant_msg 的 text 块拼接；complex → 写 state.lastDelegate、phase 转 "planning"，返回「生成 plan 并等待审批」；重复调用 delegate（phase !== "initial"）返回 isError「已判定，勿重复调用」。runMainTurn：append user_msg(main) → runTurn（main registry + tier=mainTier）→ yield 全部事件；本任务只接 trivial/simple（complex 分支 Task 8 实现，本任务先以「complex → 抛出/记录 error 事件」占位，测试不覆盖 complex）。
  测试策略注意：`scriptedAdapter` 按**全局 streamChat 调用顺序**回放——main delegate 步=脚本第 1 次调用，worker turn=第 2 次，main 收尾=第 3 次，依此编排脚本。

- [ ] **Step 1: 写失败测试**（= M2 验收 #1、#4）

main-turn.test.ts：
- trivial：脚本次 1 返回纯文本 + finish stop；断言无 agent_spawn 事件、输出包含回答文本
- simple（验收 #1 + #4）：脚本 3 次调用——①main delegate(simple, modelTier=low) ②worker 一次 tool_calls 批次（isConcurrencySafe 读工具）③main 文本收尾；**审批断言：全程无 approval/asked 事件**（不出现 plan 审批）；断言 worker 的 assistant_msg `tier === "low"`、model 为 low 档 id；断言 main 收到的 tool_result content 含 worker 摘要；**token 断言**：(main 两次请求 input+output 之和) < 0.2 × (worker 请求 input+output)——用 recording 包装 scriptedAdapter 取 usage
- 重复 delegate：脚本让 main 连续两次 delegate，第二次返回 isError

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/orchestrator/test/main-turn.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

delegate.ts/main-turn.ts 按 Interfaces；runMainTurn 用 core runTurn + createRoleRegistry("main", [delegateTool])（spawn_workers 元工具 Task 8 加入，本任务 metaTools 只装 delegate）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): delegate 工具与 trivial/simple 主流"
```

---

### Task 8: orchestrator — plan 审批流 + spawn_workers（complex 流）

**Files:**
- Create: `packages/orchestrator/src/tools/spawn-workers.ts`
- Create: `packages/orchestrator/src/plan.ts`
- Modify: `packages/orchestrator/src/main-turn.ts`（接 complex 分支）
- Test: `packages/orchestrator/test/plan-flow.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7 的 TurnState/PlanDecision；core 的 runTurn、createRoleRegistry
- Produces:
  ```ts
  export function createSpawnWorkersTool(runtime: OrchestrationRuntime, state: TurnState): ToolDefinition<{ workers: { task: string; context?: string; modelTier: ModelTier }[] }>
  ```
  spawn_workers execute 守卫：`state.planApproved === false` 时返回 isError「plan 未批准」；批准后 spawn 各 worker（role=worker，tier 取参数 modelTier）内联跑 turn，聚合摘要为 content。plan.ts：`runPlanPhase(runtime, state, signal, onPlanApproval)`——修订循环：runTurn 起草（user_msg 提示起草 plan）→ 取 main 最后 assistant 文本为 plan → yield `{type:"plan", phase:"drafted", plan}` → `onPlanApproval(plan)`（缺省 fail-closed 返回 `{kind:"reject", note:"no approval handler"}`）→ 落盘 `approval/asked`（payload `{kind:"plan", plan}`）与 `approval/decided`（含 note）；approve → `state.planApproved = true`，yield approved，追加 user_msg「Plan approved...」返回；annotate → `state.revisions++`，`revisions > planMaxRevisions` 时 yield `revision_exhausted`、追加 user_msg 说明并结束（不再询问）；reject → yield denied、追加 user_msg、跑一轮收尾 runTurn 后结束。main-turn.ts：complex 分支调 runPlanPhase，批准后 runTurn 执行阶段（registry 装 delegate + spawn_workers）。

- [ ] **Step 1: 写失败测试**（= M2 验收 #2）

plan-flow.test.ts（脚本顺序：delegate→起草→(修订→起草)×n→执行）：
- 批准路径：onPlanApproval 返回 approve；断言事件序中第一个 `approval/decided` 早于任何文件写工具（write/edit/bash）的 tool_result 出现；断言 spawn_workers 后 worker 跑了、main 收到聚合摘要
- 批注路径：annotate 两次（note="加测试" / "再改"）后 approve；断言 `state.revisions === 2`、起草请求里携带了批注内容、approval/decided 带 note
- 修订上限：`planMaxRevisions=3`，连续 annotate 4 次；断言第 4 次起草后出现 `revision_exhausted`、全程只有 3 次 `approval/asked`
- 拒绝路径：reject；断言无 spawn_workers 执行、无 worker agent_spawn
- 守卫：未批准时脚本让 main 直接 spawn_workers → 返回 isError

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/orchestrator/test/plan-flow.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按 Interfaces；起草 runTurn 与执行 runTurn 都用 createRoleRegistry("main", [delegate, spawnWorkers])。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): plan 审批流与 spawn_workers（complex 流）"
```

---

### Task 9: orchestrator — spawn_tasks 并行调度与失败上报

**Files:**
- Create: `packages/orchestrator/src/tools/spawn-tasks.ts`（内含并发池）
- Modify: `packages/orchestrator/src/registries.ts`（worker 角色装 spawn_tasks 需要工厂，见下）
- Test: `packages/orchestrator/test/spawn-tasks.test.ts`（新建）

**Interfaces:**
- Produces:
  ```ts
  export function createSpawnTasksTool(runtime: OrchestrationRuntime, worker: { agentId: string; tier: ModelTier }): ToolDefinition<{ tasks: { task: string; context?: string; acceptance?: string }[] }>
  ```
  语义：每个 task spawn（role=task，tier 继承 worker）后内联跑 turn；并发池上限 `runtime.maxParallelTasks`；每个任务结果独立成段，失败（runTurn 出现 error 事件或收尾 summary 缺失）标注 `[FAILED] ${agentId}: ${reason}`；整体 content 聚合各段、任一无失败即 `isError: false`（失败段原样呈现，由 worker LLM 决定重试/接手/上报——验收 #5 只要求不静默丢失）。registries.ts 调整为导出 `createWorkerRegistry(runtime, worker)` 工厂（内部闭包装 spawn_tasks），Task 6 的 `createRoleRegistry` 保留给 main/task。

- [ ] **Step 1: 写失败测试**（= M2 验收 #3、#5）

spawn-tasks.test.ts（recording 包装 scriptedAdapter 记录并发数）：
- 8 个只读任务（验收 #3）：默认上限 10，断言 recording 的 maxConcurrent === 8、落盘 8 条 role=task 的 agent_spawn、聚合 content 含 8 段摘要
- 上限生效：runtime maxParallelTasks=2、4 个任务，断言 maxConcurrent === 2
- 失败上报（验收 #5）：8 个任务中 1 个脚本返回 error 事件，断言该段含 `[FAILED]`、其余 7 段正常、整体 isError=false；断言 worker（调用方）后续请求能看到失败内容（recording 抓 worker 下一步请求的 messages 含 `[FAILED]`）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/orchestrator/test/spawn-tasks.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按 Interfaces；并发池用简单的「取 N 个 → Promise.all → 取下一批」即可（任务为内联 turn，异常已兜底，池不抛）；abort：把 runMainTurn 的 signal 传入各任务 turn，cancel 时一并中止（Review Focus #4 由本测试与 Task 11 共同钉死，本任务测试补一例：signal 在任务执行中 abort，任务 turn 收到中止、结果段标 `[FAILED] aborted`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): spawn_tasks 并行调度与失败上报"
```

---

### Task 10: orchestrator — steer/queue 双队列（inbox/spliced 落盘 + 恢复折叠）

**Files:**
- Create: `packages/orchestrator/src/inbox.ts`
- Test: `packages/orchestrator/test/inbox.test.ts`（新建）

**Interfaces:**
- Consumes: core 的 `InboxQueue`、`InboxMessage`、`Session`；Task 2 的 `pollInbox` 钩子
- Produces:
  ```ts
  export interface Inbox {
    followup(content: string): Promise<void>;   // next-turn 排队（FIFO，turn 结束后消费）
    steer(content: string): Promise<void>;      // next-step 排队并唤醒（经 pollInbox 下步注入）
    inject(content: string): Promise<void>;     // next-step 排队不唤醒
    cancel(): void;                             // 调 opts.onCancel（CLI 侧接 AbortController）
    drainNextTurn(): Promise<InboxMessage[]>;   // 取出并清空 next-turn
    pollNextStep(): Promise<string[]>;          // 取出并清空 next-step（供 LoopConfig.pollInbox）
  }
  export function createInbox(session: Session, agentId: string, opts?: { onCancel?: () => void }): Inbox
  export function foldInbox(events: SessionEvent[]): { nextTurn: InboxMessage[]; nextStep: InboxMessage[] }
  ```
  语义：每次变更先更新内存队列再 append `inbox/spliced`（`queue` + 该队列全量快照 `messages`，消息带 id 去重）；`foldInbox` 从事件流顺序折叠出两队列最终状态（崩溃恢复用）；steer/inject 的区别仅唤醒语义，M2 唤醒由 CLI 在 turn 空闲时处理，队列数据一致。

- [ ] **Step 1: 写失败测试**

inbox.test.ts：
- followup×2 + steer×1 后：drainNextTurn 返回 2 条 FIFO 且队列清空；pollNextStep 返回 steer 内容
- 落盘：每个动词各产生一条 `inbox/spliced`、快照与内存一致；`foldInbox(loadSession(...).events)` 还原两队列（模拟 kill 恢复）
- 消息 id 去重：同 id 消息重复 splice 不重复入队
- cancel：触发 onCancel 一次

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/orchestrator/test/inbox.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按 Interfaces。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): steer/queue 双队列与 inbox/spliced 持久化"
```

---

### Task 11: cli — 接入编排入口 + plan 终端审批 UI + 既有测试迁移

**Files:**
- Modify: `packages/cli/src/chat.ts`（runChat 改调 `runMainTurn`；渲染 OrchestrationEvent 扩展；inbox 接线）
- Create: `packages/cli/src/plan-approval.ts`（终端 plan 审批 UI）
- Modify: `packages/cli/test/cli.test.ts`、`packages/cli/test/acceptance.test.ts`（脚本补 delegate 轮，迁移到编排流）
- Modify: `packages/cli/package.json`（deps 加 `@hotpot/orchestrator: workspace:*`）
- Modify: `packages/cli/README.md`、`packages/core/README.md`（如有 M1 描述过时则同步）

**Interfaces:**
- Consumes: orchestrator 的 `runMainTurn`、`PlanDecision`、`createInbox`、`createRuntime`、`resolveModel`、`OrchestrationEvent`
- Produces:
  ```ts
  export function createTerminalPlanApproval(input: Readable, output: Writable): (plan: string) => Promise<PlanDecision>
  ```
  交互：打印 plan 全文 + 提示「批准输入 y，拒绝输入 n，批注直接输入内容回车」；y/yes → approve；n/no → reject（note 为空串）；其他非空行 → annotate(note)；EOF/空行 → reject（fail-closed）。chat.ts：主循环改 `runMainTurn`（`onPlanApproval` 用上述 UI；signal 接 Ctrl-C AbortController；inbox.pollNextStep 接入 runTurn 钩子由 runMainTurn 内部完成，CLI 在 turn 结束后 drain next-turn 作为后续 user_msg）；渲染新增：`agent_spawn` → `[spawn] worker-1 (tier=low): <task 前 80 字符>`、`plan` → `[plan] drafted/approved/denied/...`；`--tier` 语义不变（主 agent 档）。审批装配改 `createAuditedApprovalChain`（command/write 审计落盘）。

- [ ] **Step 1: 先迁移既有测试到编排流（保持红→绿节奏）**

cli.test.ts / acceptance.test.ts：每个场景脚本前补 main 的 delegate 轮（simple + 对应 task 描述）；危险命令/policy 场景：delegate 后 worker 执行 bash；断言点不变（输出、审批交互、恢复续聊）。预期此刻全红（runChat 还未接 runMainTurn 时旧实现根本不走 delegate——确认红的方式：补完脚本后跑测试，失败信息应为脚本第 1 次调用被旧单 agent 流消耗导致后续 exhausted）。

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm vitest run packages/cli`
Expected: FAIL（脚本对齐新流）

- [ ] **Step 3: 实现 chat.ts 接入 + plan-approval.ts**

按 Interfaces；`runChat` 主干换 `runMainTurn`，事件渲染扩展；创建 runtime（models 从 settings 读、approval 经 audited 包装、maxParallelTasks/planMaxRevisions 从 settings 透传）；turn 间 drain next-turn 继续派发；Ctrl-C 空闲时打印提示、回合中 abort（既有 setInterruptHandler 逻辑保留，cancel 亦触发同一 abort）。

- [ ] **Step 4: 写 plan 审批 UI 测试并跑全量**

cli 追加 plan-approval 测试：输入 `y` → approve；输入 `n` → reject；输入 `加测试` → annotate(note)；EOF → reject。Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packages/cli
git commit -m "feat(cli): 接入三层编排入口与 plan 终端审批"
```

---

### Task 12: M2 验收回归 + 文档同步

**Files:**
- Modify: `docs/PRD.md`（M2 状态一句话）、`docs/archive/04-roadmap.md`（仅当验收中发现与文档冲突需记录决议时）
- Test: `packages/orchestrator/test/m2-acceptance.test.ts`（新建，串一遍 5 条验收的端到端断言）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 写 M2 验收集成测试**

m2-acceptance.test.ts 五条用例对应 04-roadmap 验收 1-5（复用前序测试已钉的断言，这里只做场景级串联：simple 无审批+tier 正确、complex 先批后改、8 任务并行、失败上报、恢复后队列还原）。测试全部用 scriptedAdapter，不依赖真实 API。

- [ ] **Step 2: 全量回归**

Run: `pnpm test && pnpm check`
Expected: 全绿

- [ ] **Step 3: 文档同步**

PRD.md M2 行标注已实现；检查 core/orchestrator 的 README/AGENTS.md 与代码一致（tier 字段、审批事件、inbox）。

- [ ] **Step 4: 提交**

```bash
git add docs packages/orchestrator/test
git commit -m "test(orchestrator): M2 验收集成测试与文档同步"
```

---

## Self-Review 记录

- **Spec 覆盖**：04-roadmap M2 范围 5 项 → orchestrator 三层（Task 5-9）、plan 审批（Task 8）、上下文隔离与摘要回传（Task 7/9，derive 过滤 Task 1）、分层 usage 记账（Task 2 tier 落盘 + 验收 #4）、steer/queue（Task 10）；验收 1-5 分别钉在 Task 7/8/9/9/11+12。无缺口。
- **类型一致性**：TurnState/PlanDecision/OrchestrationRuntime/ModelResolution/Inbox 形状在 Task 5/7/8/10 定义处与消费处一致；`tool_result.agentId` 与 `approval/decided.note` 为仅有的两处事件格式修补，已在 Global Constraints 声明。
- **Review Focus**：5 条均已映射到 Task 1（#1 并发、#2 兼容、#5 过滤）、Task 8（#3 守卫）、Task 9/11（#4 中止）。
