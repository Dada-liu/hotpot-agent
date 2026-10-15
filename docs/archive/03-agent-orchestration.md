# 03 三层 Agent 编排详细设计

> 对应 `docs/01-requirements.md` F5。核心问题：什么时候值得拆分任务？拆分的成本必须低于收益。

## 1. 三个角色

| 角色 | 一个会话中数量 | 职责 | 可用工具 |
|------|----------------|------|----------|
| 主 agent（MainAgent） | 1 | 对话入口；理解用户意图；评估任务难度与模型档位；生成 plan；汇总结果回复用户 | 不直接操作文件，只有编排工具：delegate、spawn_workers、request_approval |
| 从 agent（WorkerAgent） | 1..N | 接收一个明确任务并执行完成；判断是否需要并行拆分 | 四个基础工具 + spawn_tasks |
| 子 agent（TaskAgent） | 0..N | 执行不可再分的原子任务（如「审查文件 X」「实现模块 Y」） | 四个基础工具，无派生能力 |

关键约束：只有三层，TaskAgent 不能再派生。深度失控是 token 成本失控的主要来源。

## 2. 难度评估与模型路由

主 agent 收到用户消息后，第一个动作必须是输出结构化判定（通过 `delegate` 工具的参数体现，不单独调一次 LLM，省一次往返）。

判定输出两个字段：

**difficulty** 三选一：

| 判定 | 含义 | 流程 |
|------|------|------|
| trivial | 纯问答，不需要工具 | 主 agent 直接回答 |
| simple | 需要工具但边界清晰（改一个文件、跑一个命令） | 跳过 plan 审查，直接派 1 个 WorkerAgent |
| complex | 多模块、多步骤、有不确定性 | plan → 用户审查 → 批准后执行 |

**modelTier**（worker 档位，已确认的决议）：
- `~/.hotpot/settings.json` 预先配置 **high / medium / low 三档模型**（各档 = provider + model + 凭证）
- 主 agent 默认使用 **high** 档（可配置 `models.mainAgent`）
- 主 agent 评估难度时**同时决定 WorkerAgent 的档位**：如 simple 任务可路由到 medium/low 省钱，complex 给 high
- TaskAgent 继承其 WorkerAgent 的档位，不单独路由

判定依据写进主 agent 系统提示词，示例规则：
- 涉及文件数可预见且 ≤ 3 → simple
- 用户明确说「先给方案/先 plan」→ complex
- 需要跨模块协调或存在多种实现路线 → complex
- 拿不准 → complex（宁多一次审查，不少一次）
-  mechanical、边界清晰的任务（格式化、改名、单行修复）→ 即使 simple 也可配 low 档

## 3. 复杂任务流程（human-in-the-loop）

```
用户: "给项目加用户认证"
  │
  ▼
MainAgent: delegate(difficulty=complex, modelTier=high)
  │  生成 plan（步骤、涉及文件、验收标准）
  ▼
approval/asked(plan) ──> 用户决定: 批准 / 批注修改 / 拒绝
  │
批准 ──> MainAgent spawn WorkerAgent(plan, tier=high)
  │
  ▼
WorkerAgent 分析 plan: 可并行部分拆成 TaskAgent
  ├─ TaskAgent A: 实现后端 auth 路由
  ├─ TaskAgent B: 实现前端登录页
  └─ (A、B 完成后) WorkerAgent 自己: 联调、跑测试
  │
  ▼
WorkerAgent 汇总结果摘要 ──> MainAgent ──> 回复用户
```

- plan 未批准前，不产生任何文件修改
- 用户批注后由主 agent 修订 plan，重新发起审批。**修订轮次上限默认 3**，`settings.json` 的 `planMaxRevisions` 可配；超过则询问用户是否放弃

## 4. 并行拆分规则（WorkerAgent）

WorkerAgent 只在满足全部条件时才拆 TaskAgent：

1. 子任务间无写冲突（不修改同一文件）
2. 子任务间无顺序依赖（B 不需要 A 的输出作为输入）
3. 子任务各自足够独立完整（能一句话说清「做什么、做完的标准」）

反例（不拆）：「写函数 + 写这个函数的测试」——测试依赖函数签名，串行做。
正例（拆）：「审查这 8 个文件的类型安全问题」——8 个只读任务，天然并行。

并行上限：**默认 10 个 TaskAgent 并发**，`settings.json` 的 `maxParallelTasks` 可配（已确认决议）。

## 5. 上下文隔离与结果回传

成本核心：**上下文不共享，只回传摘要**。

- 每个 WorkerAgent / TaskAgent 有独立的消息历史，初始内容 = 系统提示词 + 上级下发的任务描述
- 子 agent 的中间过程（几十次工具调用、几万 token）不回流上级
- 任务结束时，子 agent 的最后一条 assistant 消息作为「结果摘要」回传，要求它包含：做了什么、关键文件路径、遇到的问题、验证结果
- 下级 agent 通过任务描述拿到必要背景，上级不把自己的完整对话历史塞给它

失败处理：TaskAgent 失败（工具反复报错、超限）→ 摘要标注失败原因回传 → WorkerAgent 决定重试、降级自己接手、或上报主 agent 问用户。

## 6. 编排工具定义（供 LLM tool calling）

| 工具 | 使用者 | 参数要点 |
|------|--------|----------|
| delegate | MainAgent | difficulty(trivial/simple/complex)、modelTier(high/medium/low)、task、reason |
| spawn_workers | MainAgent | workers: [{task, context, modelTier}]（complex 且 plan 已批准后使用） |
| spawn_tasks | WorkerAgent | tasks: [{task, context, acceptance}] |
| request_approval | MainAgent / WorkerAgent | kind(plan/command)、payload |
| report_result | WorkerAgent / TaskAgent | summary、artifacts(文件路径列表)、status |

## 7. steer / queue 设计（M2 预留 API，M4 完成界面）

借鉴 dsh 的 inbox 模型与 pi 的 steeringQueue：**两条持久队列 + 四个动词**。

- 队列：
  - `next-turn`（queue）：主 agent 忙碌时排队，当前 turn 结束后按 FIFO 注入
  - `next-step`（steer）：当前 step（一次请求 + 其工具批次）结束后立即注入并唤醒主 agent
- 动词：`followup()`（排 next-turn）、`steer()`（排 next-step 并唤醒）、`inject()`（排 next-step 不唤醒）、`cancel()`（中断当前 turn）
- **队列变更写会话事件**（`inbox/spliced`），崩溃恢复后队列状态还原，带消息 id 去重（借鉴 dsh）
- steer 只作用于主 agent 的消息流，不直接干预子 agent（避免状态撕裂）；主 agent 看到 steer 后自行决定调整方向 / 中断下级 / 忽略

## 8. token 成本控制

| 手段 | 说明 |
|------|------|
| 编排层级最小化 | simple 任务只有 主→从 两层一跳，不生成 plan、不审查 |
| 摘要回传 | 见第 5 节 |
| 分层模型路由 | 见第 2 节：主 agent 固定高档，worker/task 按难度路由到中低档 |
| 派生带上文裁剪 | spawn 时只传任务描述，不传历史 |
| 观测 | 每个 agent 的 usage 单独记账（事件含 `agentId` + `tier`），可按层级拆分成本 |

## 9. 已确认决议记录

| 问题 | 决议 |
|------|------|
| 并行 TaskAgent 上限 | 默认 10，`~/.hotpot/settings.json` 的 `maxParallelTasks` 可配 |
| plan 审批修订轮次上限 | 默认 3，`planMaxRevisions` 可配 |
| 分层模型配置 | M2 实现；settings.json 配 high/medium/low 三档；主 agent 默认 high；worker 档位由主 agent 评估难度时决定；task 继承 worker 档位 |
