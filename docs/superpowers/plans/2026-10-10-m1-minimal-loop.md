# M1 最小可用闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在终端跑通 hotpot-code 的「对话 → 工具调用 → 完成任务」最小闭环：LLM 双协议适配、turn/step 循环、四个基础工具、JSONL 会话日志、CLI 入口。

**Architecture:** pnpm monorepo，三个包：`packages/ai`（api×provider 二维适配，anthropic-messages + openai-completions 两个协议）、`packages/core`（append-only JSONL 事件日志为唯一事实源，deriveMessages 折叠历史；turn/step 两级循环；工具三面分离 execute/render/present；审批 waterfall）、`packages/cli`（行式交互入口）。详见架构文档。

**Tech Stack:** Node >= 22、TypeScript（erasable-syntax-only，`.ts` 后缀 import，tsx 开发直跑）、pnpm、vitest、zod、biome。

**Spec:** `docs/PRD.md`（细节依据：`docs/archive/01-requirements.md` F1-F4/F6、`docs/archive/02-architecture.md` 第 1-6 节）

## Global Constraints

- Node >= 22；TS 只用 erasable 语法（无 enum/namespace/参数属性/`import =`）；源码间 import 带 `.ts` 后缀
- 严格类型：no `any`；无 inline import（顶层 import only）
- 代码注释与 README.md 用简体中文；LLM prompt 与 AGENTS.md 用英文
- 每个新建文件夹必须带 `README.md`（做了什么，中文）和 `AGENTS.md`（怎么改，英文）
- 依赖白名单：`zod`；devDependencies：`typescript`、`tsx`、`vitest`、`@biomejs/biome`、`tsdown`。新增依赖需用户批准
- 提交信息：conventional commits，无 emoji
- 配置 home：`~/hotpot-code/`（env `HOTPOT_HOME` 可覆盖，供测试隔离）

## Review Focus

1. SSE 流在多字节 UTF-8 字符或 JSON 行中间拆包 → 解码器必须按字节缓冲拼行（Task 3、4 各配测试）
2. `finish reason = max_tokens` 时消息内 tool call 参数可能被截断 → 该消息全部 tool call 判失败、不执行（Task 10 配测试）
3. 会话文件末行损坏（崩溃写了一半）→ 加载时跳过不完整行，仍可恢复（Task 5 配测试）
4. `settings.json` 里 apiKey 的 `$ENV` 变量未设置 → 报出变量名的明确错误，不静默传空 key（Task 11 配测试）
5. read/edit 遇到非 UTF-8 字节或 CRLF 混合行尾 → read 拒绝二进制并提示；edit 按精确字节语义匹配（Task 9 配测试）

---

### Task 1: monorepo 脚手架与工程约定

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`biome.json`、`vitest.config.ts`
- Create: `packages/ai/package.json`、`packages/ai/tsconfig.json`、`packages/ai/README.md`、`packages/ai/AGENTS.md`
- Create: `packages/core/...`（同上四件）、`packages/cli/...`（同上四件）

**Interfaces:**
- Produces: `pnpm test`（vitest 跑 `packages/*/test/**/*.test.ts`）；`pnpm dev <pkg>`（tsx 运行）；tsconfig 开 `erasableSyntaxOnly`、`allowImportingTsExtensions`、`rewriteRelativeImportExtensions`、`strict`

- [ ] **Step 1: 写冒烟测试** `packages/core/test/smoke.test.ts`：断言 `1 + 1 === 2`（占位，验证管线）
- [ ] **Step 2: 运行 `pnpm test` 确认失败**（vitest 未装/未配）
- [ ] **Step 3: 创建脚手架文件**；三个包的 package.json 声明 `"type": "module"`，workspace 互相依赖用 `workspace:*`
- [ ] **Step 4: `pnpm install && pnpm test` 通过；`pnpm exec biome check` 通过**
- [ ] **Step 5: 补三个包的 README.md（中文）/AGENTS.md（英文）**，根 README.md 目录结构去掉「待 M1 启动后创建」标注
- [ ] **Step 6: Commit** `chore: scaffold pnpm monorepo`

### Task 2: packages/ai 类型与模型目录

**Files:**
- Create: `packages/ai/src/types.ts`、`packages/ai/src/models.ts`、`packages/ai/src/index.ts`
- Test: `packages/ai/test/models.test.ts`

**Interfaces:**
- Produces（后续任务只认这些名字）:
  - `type ContentBlock = {type:"text";text:string} | {type:"tool_call";id:string;name:string;input:unknown} | {type:"tool_result";toolCallId:string;content:string;isError:boolean}`
  - `type Message = {role:"user"|"assistant";content:ContentBlock[]}`（tool_result 以 role:"user" 消息承载）
  - `interface ToolDeclaration { name:string; description:string; parameters:Record<string,unknown> }`（JSON Schema）
  - `type StreamEvent = {type:"text_delta";delta:string} | {type:"reasoning_delta";delta:string} | {type:"tool_call_start";id:string;name:string} | {type:"tool_call_delta";id:string;inputDelta:string} | {type:"tool_call_end";id:string} | {type:"usage";usage:Usage} | {type:"finish";reason:FinishReason}`
  - `type Usage = { input:number; output:number; cacheRead?:number; cacheWrite?:number }`；`type FinishReason = "stop"|"tool_calls"|"max_tokens"|"aborted"|"error"`
  - `class LlmError extends Error { code:string; status?:number; retryAfter?:number }`
  - `interface ModelInfo { id:string; provider:string; api:"anthropic-messages"|"openai-completions"; contextWindow:number; maxTokens:number; cost:{input:number;output:number} }`（cost 单位：美元/百万 token）
  - `interface ChatRequest { model:ModelInfo; apiKey:string; baseUrl?:string; system:string; messages:Message[]; tools:ToolDeclaration[] }`
  - `interface LlmAdapter { api:string; streamChat(req:ChatRequest, signal:AbortSignal): AsyncIterable<StreamEvent> }`
  - `MODELS: ModelInfo[]` 常量；`findModel(provider:string, id:string): ModelInfo | undefined`
  - `type FetchLike = (url:string, init:{method:string;headers:Record<string,string>;body:string;signal:AbortSignal}) => Promise<{ok:boolean;status:number;headers:Headers;body:ReadableStream<Uint8Array>|null}>`（注入点，测试用）

- [ ] **Step 1: 写失败测试** `models.test.ts`：断言 `MODELS` 至少含 4 个模型（anthropic claude-sonnet-4-5、openai gpt-4.1、deepseek deepseek-chat、moonshot kimi-k2），每个 `contextWindow > 0`、`cost.input >= 0`；`findModel("anthropic","claude-sonnet-4-5")` 命中、`findModel("x","y")` 返回 undefined
- [ ] **Step 2: 跑测试确认失败**（模块不存在）
- [ ] **Step 3: 实现 `types.ts`（纯类型）与 `models.ts`（上表 4 个模型的真实 contextWindow/maxTokens/定价常量）**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(ai): types and model catalog`

### Task 3: openai-completions 协议适配器

**Files:**
- Create: `packages/ai/src/api/openai-completions.ts`、`packages/ai/src/sse.ts`
- Test: `packages/ai/test/openai-completions.test.ts`、`packages/ai/test/fixtures/openai-*.sse.txt`

**Interfaces:**
- Consumes: Task 2 全部类型
- Produces: `createOpenAICompletionsAdapter(fetchImpl?:FetchLike): LlmAdapter`；`parseSseStream(body:ReadableStream<Uint8Array>): AsyncIterable<string>`（产出每个 `data:` 载荷，按字节缓冲，处理 `[DONE]`）

- [ ] **Step 1: 写 fixture 与失败测试**：录制两段 SSE 文本（一段含 text delta + finish stop；一段含 tool_call 增量分多帧 + finish tool_calls），外加三个拆包用例：多字节 UTF-8 字符跨 chunk、一个 JSON 行跨两个 chunk、末尾无换行。测试用注入的 FetchLike 返回 fixture 字节流，断言产出的 StreamEvent 序列（text_delta 拼接结果完整、tool_call_delta 的 inputDelta 拼接后是合法 JSON、finish reason 正确、usage 事件数值正确）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `sse.ts`（字节缓冲 + `\n\n` 分帧 + `[DONE]` 终止）与 `openai-completions.ts`（请求体构造：messages/tools 转换；响应增量 → StreamEvent；非 2xx → LlmError 含 status 与 retry-after）**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(ai): openai-completions adapter`

### Task 4: anthropic-messages 协议适配器

**Files:**
- Create: `packages/ai/src/api/anthropic-messages.ts`
- Test: `packages/ai/test/anthropic-messages.test.ts`、`packages/ai/test/fixtures/anthropic-*.sse.txt`

**Interfaces:**
- Consumes: Task 2 类型、`parseSseStream`
- Produces: `createAnthropicMessagesAdapter(fetchImpl?:FetchLike): LlmAdapter`

- [ ] **Step 1: 写 fixture 与失败测试**：Anthropic 事件序列（`message_start` / `content_block_start`(text|tool_use) / `content_block_delta`(`text_delta`|`input_json_delta`) / `message_delta`(含 stop_reason + usage) / `message_stop`），断言映射到统一 StreamEvent：stop_reason `end_turn→stop`、`tool_use→tool_calls`、`max_tokens→max_tokens`；usage 含 cacheRead（`cache_read_input_tokens`）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现适配器**（请求：system 独立字段、messages 转换、tools 转 `input_schema`；`anthropic-version: 2023-06-01` 头）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(ai): anthropic-messages adapter`

### Task 5: 会话事件日志与 deriveMessages

**Files:**
- Create: `packages/core/src/session/events.ts`、`packages/core/src/session/store.ts`、`packages/core/src/session/derive.ts`
- Test: `packages/core/test/session.test.ts`

**Interfaces:**
- Produces:
  - `type SessionEvent`（联合，v1：`meta|user_msg|assistant_msg|tool_call|tool_result|agent_spawn|approval/asked|approval/decided|inbox/spliced|error`，字段对齐 `docs/archive/02-architecture.md` 第 5 节；M1 只写入，agent_spawn/inbox 类型先定义不产生）
  - `createSession(cwd:string, home?:string): Promise<Session>`；`Session = { id:string; filePath:string; append(e:SessionEvent):Promise<void> }`（append 后 fsync）
  - `loadSession(filePath:string): Promise<{meta:SessionEvent; events:SessionEvent[]}>`（跳过末尾不完整行）
  - `listSessions(home?:string): Promise<Array<{id:string;filePath:string;createdAt:string;cwd:string}>>`
  - `deriveMessages(events:SessionEvent[], agentId:string): Message[]`（复用 ai 包 Message；assistant_msg 的 content 直接是 ContentBlock[]；tool_result 折叠为 role:"user" 消息）
  - 会话路径：`$HOTPOT_HOME/sessions/<cwd 编码（/ 与 : 替换为 -）>/<yyyymmdd-hhmmss>_<id>.jsonl`

- [ ] **Step 1: 写失败测试**：写 5 个事件（meta/user_msg/assistant_msg 含 tool_call/tool_result/assistant_msg 纯文本）→ `deriveMessages` 产出 4 条 Message 且顺序与类型正确；文件末尾追加半行损坏 JSON 后 `loadSession` 不抛错且事件数不变；`listSessions` 能找到刚创建的会话
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现三个文件**（append-only + fsync；加载按行解析，坏行跳过；cwd 编码规则如上）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(core): session event log and deriveMessages`

### Task 6: 系统提示词 section 注册表

**Files:**
- Create: `packages/core/src/prompt/sections.ts`、`packages/core/src/prompt/default-sections.ts`
- Test: `packages/core/test/prompt.test.ts`

**Interfaces:**
- Produces: `interface PromptSection { name:string; order:number; text:string | ((ctx:PromptContext)=>string) }`；`PromptContext = { cwd:string; os:string; date:string; tools:ToolDeclaration[] }`；`registerSection(s:PromptSection):void`；`buildSystemPrompt(ctx:PromptContext): string`（按 order 升序拼接，段间空行）；默认段常量 `SECTION_ORDER = { IDENTITY:0, TOOLS:1000, RULES:2000, ENV:3000 }`

- [ ] **Step 1: 写失败测试**：注册两个乱序 section 后输出顺序按 order；函数型 section 拿到 ctx；默认 sections 构建的 prompt 含工具名与 cwd；全英文断言（prompt 必须英文）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现注册表与默认段**（identity/tools/rules/env 四段，英文文案）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(core): system prompt section registry`

### Task 7: 工具框架与审批 waterfall

**Files:**
- Create: `packages/core/src/tools/tool.ts`、`packages/core/src/tools/registry.ts`、`packages/core/src/approval/chain.ts`
- Test: `packages/core/test/tool-framework.test.ts`

**Interfaces:**
- Produces:
  - `interface ToolDefinition<T> { name:string; description:string; parameters:ZodType<T>; timeoutMs?:number; isConcurrencySafe?:boolean; execute(args:T, ctx:ToolContext):Promise<ToolOutput>; render?(o:ToolOutput):string; present?(args:T, o:ToolOutput):string }`
  - `ToolOutput = { content:string; isError?:boolean; details?:unknown }`；`ToolContext = { cwd:string; signal:AbortSignal; approval:ApprovalChain }`
  - `ToolRegistry = { register(t:ToolDefinition<unknown>):void; declarations():ToolDeclaration[]; get(name:string):ToolDefinition<unknown>|undefined }`（declarations 输出 JSON Schema，zod 转换）
  - `type ApprovalRequest = { kind:"command"|"write"; summary:string; detail:string }`；`type ApprovalDecision = "allow"|"deny"`；`type ApprovalHandler = (req:ApprovalRequest) => Promise<ApprovalDecision|"next">`；`class ApprovalChain { use(h:ApprovalHandler):void; ask(req:ApprovalRequest):Promise<ApprovalDecision> }`（顺序询问，任一手柄返回 allow/deny 即短路；全部 next → 默认 deny，fail-closed）

- [ ] **Step 1: 写失败测试**：zod schema → declarations 的 JSON Schema 含属性与 required；两个 handler 链上第一个返回 next、第二个 deny → 结果 deny；全部 next → deny
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现三个文件**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(core): tool framework and approval chain`

### Task 8: bash 工具

**Files:**
- Create: `packages/core/src/tools/bash.ts`
- Test: `packages/core/test/bash.test.ts`

**Interfaces:**
- Consumes: Task 7 框架
- Produces: `bashTool: ToolDefinition<{command:string; timeoutMs?:number}>`；输出 content = stdout+stderr+exit code 文本；超时 `timeoutMs`（默认 120000）kill 并 isError；高危模式（`rm -rf`、`mkfs`、`> /dev/`、`dd if=` 等正则表）先走 `ctx.approval.ask({kind:"command",...})`，deny 则返回 isError 且不执行

- [ ] **Step 1: 写失败测试**：`echo hi` → content 含 hi、exit 0；`exit 3` → isError 且含 exit code；超时（`sleep 5` + timeoutMs 200）→ isError 含 timeout；命中 `rm -rf /tmp/x` 时 approval deny → 未执行（文件仍在），allow → 执行
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（spawn `bash -c`，收集 stdout/stderr，AbortSignal 联动 kill）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(core): bash tool`

### Task 9: read / write / edit 工具

**Files:**
- Create: `packages/core/src/tools/read.ts`、`packages/core/src/tools/write.ts`、`packages/core/src/tools/edit.ts`
- Test: `packages/core/test/fs-tools.test.ts`

**Interfaces:**
- Consumes: Task 7 框架
- Produces:
  - `readTool: ToolDefinition<{path:string; offset?:number; limit?:number}>`（offset 1-based；NUL 字节 → 拒绝并提示是二进制；单文件默认最多 2000 行，超出提示分页）
  - `writeTool: ToolDefinition<{path:string; content:string}>`（目标已存在 → 先 approval `kind:"write"`）
  - `editTool: ToolDefinition<{path:string; old_string:string; new_string:string; replace_all?:boolean}>`（old_string 出现 0 次 → isError「未找到」；>1 次且未 replace_all → isError「不唯一」并给出出现次数）

- [ ] **Step 1: 写失败测试**：覆盖上表全部行为 + Review Focus 第 5 条（CRLF 文件 edit 精确匹配；含 NUL 文件 read 拒绝）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现三个工具**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(core): read write edit tools`

### Task 10: turn/step 循环

**Files:**
- Create: `packages/core/src/agent/loop.ts`、`packages/core/src/agent/types.ts`
- Test: `packages/core/test/loop.test.ts`

**Interfaces:**
- Consumes: ai 包全部类型、Session、ToolRegistry、ApprovalChain、buildSystemPrompt
- Produces:
  - `interface AgentContext { session:Session; agentId:string; adapter:LlmAdapter; chat:()=>ChatRequest基础（model/apiKey/system/tools 由调用方组装）；registry:ToolRegistry; cwd:string }`（实现时把参数收拢为 `LoopConfig`，此处锁定名字）
  - `runTurn(cfg:LoopConfig, signal:AbortSignal): AsyncIterable<AgentEvent>`；`AgentEvent = {type:"text",delta:string} | {type:"tool_call",name:string,input:unknown} | {type:"tool_result",name:string,output:ToolOutput} | {type:"done",stopReason:FinishReason} | {type:"error",error:LlmError}`
  - step 语义：一次 streamChat + 执行该消息全部 tool call；同批 tool call 中全部 `isConcurrencySafe` 才并行，否则串行；无 tool call 且 finish=stop → turn 结束
  - 防御：`finish=max_tokens` → 该消息 tool call 全部记 isError（「参数可能被截断」）不执行；abort → 已产出事件落盘，tool 执行收到 signal

- [ ] **Step 1: 写失败测试**（FakeAdapter 按脚本回放 StreamEvent）：脚本 A「文本→stop」断言 done；脚本 B「tool_call→tool_result 后第二轮 stop」断言事件序与 session 文件事件（assistant_msg/tool_result 齐全）；脚本 C max_tokens 截断防御；脚本 D 第二轮前 abort → done(aborted) 且文件含中断前事件
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `runTurn`**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(core): turn/step agent loop`

### Task 11: 配置加载与 CLI 入口

**Files:**
- Create: `packages/core/src/config.ts`
- Create: `packages/cli/src/bin.ts`、`packages/cli/src/chat.ts`、`packages/cli/src/approval-ui.ts`
- Test: `packages/core/test/config.test.ts`、`packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: 全部前序接口
- Produces:
  - `loadSettings(home?:string): Settings`；zod schema：`Settings = { models:{high:ModelRef;medium:ModelRef;low:ModelRef}; mainAgentTier?:"high"|"medium"|"low"; maxParallelTasks?:number; planMaxRevisions?:number; approval?:{policy?:"ask-on-dangerous"|"always"|"never"} }`；`ModelRef = { provider:string; model:string; apiKey:string; baseUrl?:string }`；apiKey 支持 `"$ENV_NAME"` 引用环境变量，未设置 → 报错含变量名（Review Focus 4）
  - CLI：`hotpot chat [--session <path>] [--tier high]`；行式交互：输入消息 → 流式打印 text → tool_call 展示名称与参数摘要 → approval 询问 `y/n` → 结果摘要；`--session` 恢复：loadSession + deriveMessages 续聊；`/exit` 退出

- [ ] **Step 1: 写失败测试**：config——合法 settings 解析、缺档位报错、`$ENV` 插值与未设置报错；cli——用 FakeAdapter + 临时 HOTPOT_HOME 跑一遍「问→答→/exit」脚本，断言输出含回答文本且生成了会话文件
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 config 与 CLI**（readline 行式交互；真实 adapter 由 settings 的 provider→api 映射选择）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(cli): settings loading and chat entry`

### Task 12: M1 验收与文档收尾

**Files:**
- Create: `packages/cli/test/acceptance.test.ts`
- Modify: `README.md`、`packages/*/README.md`

**Interfaces:**
- Consumes: 全部

- [ ] **Step 1: 写验收测试**（FakeAdapter 脚本化）：模拟「统计行数写入 report.txt」多步工具调用场景，断言 report.txt 生成且会话文件含完整事件链；模拟 kill 后用 loadSession 恢复并继续一轮对话
- [ ] **Step 2: 跑测试确认失败→通过全过程**
- [ ] **Step 3: 真实冒烟（人工步骤，执行者需配好 ~/hotpot-code/settings.json 三档模型）：`pnpm dev cli chat` 完成 M1 验收场景 1、2**
- [ ] **Step 4: 更新 README.md 当前状态为「M1 完成」；检查 packages 三个包的 README/AGENTS 与实现一致**
- [ ] **Step 5: `pnpm test` 全绿 + `pnpm exec biome check` 干净，Commit** `docs: m1 acceptance`

---

## Self-Review 记录

- Spec 覆盖：F1→Task 10/12；F2→Task 6；F3→Task 7/8/9；F4→Task 2/3/4；F6→Task 5/12；M1 只做 CLI→Task 11；配置三档模型→Task 11。P0 中 F5/F7 属 M2/M3，不在本计划
- 类型一致性：`StreamEvent/Message/ToolDeclaration/ToolOutput/ApprovalChain/runTurn/loadSettings` 全计划统一
- Review Focus 5 条均已落到对应任务的测试步骤
