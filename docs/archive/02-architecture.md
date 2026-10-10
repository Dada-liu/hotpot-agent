# 02 总体架构

> 本文档描述系统分层、包划分、关键数据流、存储格式与配置体系。
> 技术方案调研参考了两个同类项目：`pi`（@earendil-works 的 monorepo code agent）和 `deepseek-harness`（简称 dsh，插件化 agent harness）。借鉴点与不借鉴点见第 7、8 节。

## 1. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 语言/运行时 | Node >= 22 + TypeScript | PRD 要求；pi 与 dsh 均如此 |
| TS 约束 | erasable-syntax-only，源码间用 `.ts` 后缀 import | AGENTS.md 硬性规则；pi 同款配置（`erasableSyntaxOnly` + `rewriteRelativeImportExtensions`） |
| 开发期运行 | Node strip-only 直接跑 TS（可用 tsx） | pi/dsh 都是零编译开发体验，tsc/tsdown 只用于发布 |
| 包管理 | pnpm monorepo | dsh 同款；多包共享类型 |
| 构建发布 | tsdown（发布时才用） | 比逐包 `tsc -b` 简单，dsh 在用 |
| 测试 | vitest | pi/dsh 均使用 |
| lint/format | biome | pi 在用，lint+format 一体（dsh 用 oxlint，功能重合，二选一即可） |
| 工具 schema | zod | pi 用 typebox、dsh 用自研 DSL（过重）；zod 生态成熟，可转 JSON Schema |
| 前端 | React + Vite | dsh 的 apps/web 同款 |
| 后端 | Hono（HTTP + SSE） | 轻量、SSE 支持好；dsh 用裸 node http + ws，Hono 更省开发量 |

## 2. 分层架构

```
┌─────────────────────────────────────────┐
│  packages/web    (React SPA)            │
│  packages/cli    (终端入口，M1 唯一界面)  │  接入层：只负责 IO 渲染与用户输入
├─────────────────────────────────────────┤
│  packages/server (HTTP + SSE API)       │  服务层：会话管理、事件推送（M3 引入）
├─────────────────────────────────────────┤
│  packages/orchestrator                  │  编排层：三层 agent、plan 模式、
│                                         │        human-in-the-loop、任务队列
├─────────────────────────────────────────┤
│  packages/core                          │  核心层：agentic loop、系统提示词、
│                                         │        工具系统、会话事件日志
├─────────────────────────────────────────┤
│  packages/ai                            │  适配层：provider 无关 LLM 接口、
│                                         │        流式、tool calling、用量统计
└─────────────────────────────────────────┘
```

依赖方向严格自上而下，禁止反向依赖。`core` 不感知编排，`orchestrator` 不感知 HTTP。

## 3. 包划分

### packages/ai — LLM 适配器
- **api × provider 二维适配**（借鉴 pi）：抽象轴是「协议」（anthropic-messages、openai-completions），provider = 协议 + baseUrl + 凭证的组合。M1 只实现这两个协议，即可覆盖 Anthropic / OpenAI / DeepSeek / Kimi 等
- 统一接口：`streamChat(messages, tools, options) → AsyncIterable<StreamEvent>`
- StreamEvent 类型：`block_start / text_delta / reasoning_delta / tool_call_delta / block_end / usage / finish(reason: stop|tool_calls|max_tokens|aborted|error)`（借鉴 dsh 的 StreamChunk 形状）
- 结构化错误：统一错误类型含机器码、HTTP status、`retryAfter`；重试走指数退避
- 模型元数据 catalog：`contextWindow`、`maxTokens`、`reasoning 档位`、`cost`；M1 手写少量模型常量即可，不做 pi 那种 40+ provider 的生成管线

### packages/core — agent 核心
- **turn/step 两级循环**（借鉴 dsh）：turn = 一次用户意图的完整处理；step = 一次 LLM 请求 + 它触发的工具批次。无新工作时 turn 关闭
- **消息历史 = 会话日志投影**（借鉴 dsh/pi，最重要的一个决策）：不维护游离的内存消息数组。所有状态（消息、工具结果、系统提示词变更、队列变更）都是 append-only 事件日志里的条目，调 LLM 前由 `deriveMessages()` 从日志折叠出模型可见历史。不变量：**模型可见 ⟺ 已记录**。恢复、回放、审计、调试由此免费获得
- 中断：AbortSignal 贯穿流式请求与每个工具执行；被中断的 assistant 消息把已收到的前缀落盘并标记 `interrupted: true`，不伪造历史
- 防御细节（借鉴 pi）：`finish reason === max_tokens` 的消息，其 tool call 全部判失败不执行（参数可能被截断）
- 系统提示词：**section 注册表**（借鉴 dsh/pi）——每段有 name + order，插件/功能模块注册自己的段；集中分配 order 常量；英文撰写，组装逻辑有单元测试
- 工具系统：
  - 接口三面分离（借鉴 dsh）：`execute(args) → 结构化结果（lossless JSON）`；`render(result) → 给模型的内容`（纯函数）；`present(args, result) → 给 UI 的展示投影`（纯函数）
  - 内置 bash / read / write / edit
  - 权限钩子：工具执行前 waterfall 审批链（借鉴 dsh `approval/asked|decided` 审计事件对）；高危命令确认、沙箱都挂在这条链上
  - 工具可声明 `isConcurrencySafe`，同批 tool call 默认并行，不安全的串行（借鉴 dsh/pi）

### packages/orchestrator — 三层编排
- MainAgent / WorkerAgent(从) / TaskAgent(子)，复用 core 的 turn/step 循环，差异在系统提示词与可用工具集
- 难度评估 + 模型路由、plan 生成与审批、任务拆分与并行调度
- steer/queue 双队列（见 03 文档第 7 节）
- 详见 `docs/03-agent-orchestration.md`

### packages/server — API 服务（M3）
- REST：会话 CRUD；SSE：事件推送（含断线重连后从日志补发）
- POST 消息 / 审批决定 / steer 指令

### packages/web — 前端（M3）
- 会话列表页、对话页（流式渲染 markdown）、工具调用卡片、plan 审查面板、用量展示

### packages/cli — 终端入口（M1 唯一界面）
- 最小可用：直接对话、恢复会话、审批交互
- 不引入自研 TUI 库（pi 自研 TUI 是一个包的工作量，过重）；M1 用行式交互即可

## 4. 关键数据流：一次用户消息

```
cli/web ──> orchestrator.MainAgent
MainAgent 第一个动作 = 结构化判定（难度 + worker 模型档位）:
  ├─ trivial → 直接回答
  ├─ simple  → spawn WorkerAgent(指定档位)
  └─ complex → plan → approval/asked ──> 用户批准 ──> spawn WorkerAgent
WorkerAgent: 可并行则 spawn TaskAgent × N（上限可配，默认 10）
每个 agent 的每次 step:
  deriveMessages() ──> ai.streamChat ──> provider
  tool call ──> 审批 waterfall（需确认则 approval/asked 阻塞等待）
  所有事件 append 到会话 JSONL + 推给 UI
```

## 5. 会话存储：append-only JSONL 事件日志

每会话一个文件，append-only，**日志即唯一事实源**。

- 位置：`~/hotpot-code/sessions/<cwd 编码>/<timestamp>_<session-id>.jsonl`（借鉴 pi 按 cwd 分目录）
- 格式直接定 v1 定稿，不做 dsh 那种 v0→v4 相邻迁移链；真出现 v2 需求时再加迁移
- 恢复 = 顺序折叠日志，重建各 agent 的消息历史与队列状态

事件类型（v1）：

```jsonc
{"type":"meta","sessionId":"...","createdAt":"...","cwd":"...","formatVersion":1}
{"type":"turn/start|turn/end","id":"...","ts":"...","agentId":"main"}
{"type":"user_msg","id":"...","ts":"...","content":"...","agentId":"main"}
{"type":"assistant_msg","id":"...","ts":"...","agentId":"main","content":[...],"usage":{"input":123,"output":45},"model":"...","tier":"high"}
{"type":"request_header","id":"...","ts":"...","agentId":"...","configHash":"...","toolsHash":"..."}
{"type":"tool_call","id":"...","ts":"...","agentId":"...","name":"bash","input":{...}}
{"type":"tool_result","id":"...","ts":"...","toolCallId":"...","content":"...","isError":false}
{"type":"agent_spawn","id":"...","ts":"...","parentAgentId":"main","agentId":"worker-1","role":"worker","task":"...","tier":"medium"}
{"type":"approval/asked","id":"...","ts":"...","agentId":"...","payload":{...}}
{"type":"approval/decided","id":"...","ts":"...","requestId":"...","decision":"approved"}
{"type":"inbox/spliced","id":"...","ts":"...","agentId":"main","queue":"next-step","messages":[...]}
{"type":"error","id":"...","ts":"...","agentId":"...","code":"...","message":"..."}
```

要点：
- 一个会话内所有 agent（含子 agent）写同一文件，`agentId` 区分
- `request_header`：config + 工具 schema 快照变化时才记新条目（借鉴 dsh），支撑缓存命中分析
- 队列变更（`inbox/spliced`）也落盘，崩溃恢复后 steering 队列不丢（借鉴 dsh）
- 崩溃最多丢最后一行；关键事件写入后 fsync

## 6. 配置体系

home 目录：`~/hotpot-code/`（用户级，环境变量可覆盖）。

```
~/hotpot-code/
├── settings.json     # 主配置
├── sessions/         # 会话日志
└── memory/           # 用户记忆（M4）
```

`settings.json` 可配项（随里程碑增加，加粗为已确认需求）：

| 配置项 | 默认 | 说明 |
|--------|------|------|
| **models.high / models.medium / models.low** | 必填 | 三档模型：provider、model、baseUrl、apiKey（支持 `$ENV` 引用环境变量） |
| models.mainAgent | high | 主 agent 默认档位 |
| **maxParallelTasks** | **10** | 并行 TaskAgent 上限 |
| **planMaxRevisions** | **3** | plan 审批修订轮次上限 |
| approval.policy | ask-on-dangerous | 高危命令确认策略 |
| telemetry.enabled | true | 本地遥测开关 |

项目级配置（`<项目>/.hotpot-code/settings.json` 覆盖用户级）留到 M4 再做，需要配套 project trust 机制防注入（借鉴 pi）。

## 7. 从 pi / dsh 借鉴的设计（汇总）

| 设计 | 来源 | 落点 |
|------|------|------|
| 日志即唯一事实源，deriveMessages 折叠历史 | dsh | core |
| turn/step 两级循环 | dsh | core |
| 系统提示词 section 注册表（name + order） | dsh/pi | core |
| 工具三面分离：execute / render / present | dsh | core |
| 审批 waterfall + asked/decided 审计事件对 | dsh | core |
| steer 双队列且队列变更落事件 | dsh/pi | orchestrator |
| api × provider 二维适配 + 模型 catalog | pi | ai |
| max_tokens 截断消息的 tool call 全判失败 | pi | core |
| 按 cwd 分目录的会话存储 | pi | core |
| 中断前缀落盘、不伪造历史 | dsh/pi | core |

## 8. 明确不借鉴（过重）

| 项 | 理由 |
|----|------|
| dsh 的 Cordis 插件树 + YAML patch 组合层（319 个包） | 产品级分发机制，内部项目不需要；用简单注册表替代 |
| pi 的自研 TUI 库 + napi 原生模块 | 一个包的工作量；M1 行式交互，界面重心在 web |
| 40+ provider 适配与模型生成管线 | M1 两个协议足够，模型常量手写 |
| declaration merging 扩展事件类型（pi/dsh 都在用） | 类型魔法重、编译期耦合；用显式联合类型 |
| dsh 自研 schema DSL（编译 JSON Schema + 双端代码生成） | zod 替代 |
| 会话格式迁移链、zstd 压缩、lease 文件 | v1 一次定稿，需要时再加 |
| dsh 的 PTC（run_code）、Electron desktop、Python SDK、CBOR 远程协议 | 多形态产品能力，超出当前定位 |

## 9. 扩展点预留

| 扩展功能 | 预留位置 |
|----------|----------|
| MCP | core 工具注册表增加 MCP 工具适配器（工具名 `mcp__<server>__<tool>`，pi/dsh 同款命名） |
| skill | 系统提示词 section 注册表加 skills 段：启动时只注入 name+description+路径，模型按需自行 read（pi 的渐进加载方式，省 token） |
| hooks | 审批 waterfall 泛化为生命周期钩子链（session_start、pre/post tool、turn_end） |
| 用户记忆 | server 会话启动时注入记忆摘要 section；写记忆走独立工具 |
| 向量数据库 | 独立 packages/memory 包（M4），core 不依赖 |
| 沙箱 | 审批链上的执行器替换点，接口不变 |
| steer/queue | orchestrator 的双队列，M2 预留 API，M4 完成 |
| todo / plan 模式 | plan 状态作为会话事件（借鉴 dsh `plan/mode` 为唯一状态源）；todo 作为工具 |
