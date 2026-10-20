# `@hotpot/telemetry`

M5.1 匿名遥测客户端。`@hotpot/cli` 与 `@hotpot/server` 在启动时装配它，把每个用户 turn 折叠成匿名指标后异步批量上报；后续 benchmark runner 复用同一套客户端，以 `kind: "benchmark"` 隔离数据。

本包是**旁路**：上报失败、配置错误、会话日志损坏都不会抛错或阻塞 agent 主流程。数据边界见下方「事件白名单」与「不采集用户内容」。

## 模块

| 文件 | 职责 |
|------|------|
| `src/events.ts` | 事件契约与 zod schema（`SCHEMA_VERSION = 1`）：九类事件 + 批量信封 |
| `src/sanitize.ts` | 错误消息脱敏（代码块、URL、邮箱、路径），默认截断到 500 字符 |
| `src/install-id.ts` | 匿名安装 ID 的读取与生成 |
| `src/client.ts` | 内存队列、阈值/定时 flush、批量 POST、指数退避重试 |
| `src/collector.ts` | 单 turn 采集：观察编排事件 + 从会话 JSONL 折叠整棵 agent 树 |
| `src/runtime.ts` | cli/server 共用装配：settings + install ID + client + collector 工厂 |
| `src/defaults.ts` | `DEFAULT_TELEMETRY_ENDPOINT`（源码常量，默认为部署的 telemetry server）与 `APP_VERSION` |

## 上报链路

```text
cli / server
  └─ createTelemetryRuntime(settings, { home, appVersion, fetchImpl? })
       ├─ 关闭或 endpoint 不可用 → null（调用方全部跳过，无额外分支）
       └─ 启用 → runtime
            ├─ collector = runtime.createCollector(session, { turnId, features })
            │     start()   → turn_start
            │     observe() → 记录 done/error/plan/agent_spawn（只判结果，不读内容）
            │     finish()  → 从会话 JSONL 折叠 llm_call/tool_call/error/feature_usage
            │                 + 最后一条 turn_end
            └─ client.enqueue(event) → 内存队列
                 └─ 阈值（默认 50 条）/定时（默认 30s）/close 时 flush
                      → POST <endpoint>/api/v1/ingest
```

server 侧整个 `createSessionManager` 共用一个 runtime；cli 侧一次 REPL 共用一个 runtime。`session_start` 在会话创建/恢复时入队；server 在每个会话的 `close(id)` 时、cli 在进程退出时尽力发送 `session_end`（best-effort，不保证送达）。没有 manager 级 close。

## 事件白名单

schema v1 只允许以下字段（每个事件另有 `eventId`、`ts`）。所有对象均 `.strict()`，未知字段直接判为非法，而不是静默剥离：

| 事件 | 允许字段 |
|------|----------|
| `session_start` | sessionId、resumed、appVersion、os?、nodeVersion?、features? |
| `session_end` | sessionId、durationMs、turns、errors、appVersion?、os?、nodeVersion?、features? |
| `turn_start` | turnId、sessionId、planUsed? |
| `turn_end` | turnId、sessionId、planUsed、outcome、durationMs、mainSteps、assistantMessages、workerCount、taskCount、inputTokens、outputTokens、byTier、byModel |
| `llm_call` | turnId、agentId、agentRole、tier、model、inputTokens、outputTokens、cacheReadTokens、cacheWriteTokens、stepIndex |
| `tool_call` | turnId、agentRole、toolName、durationMs、durationApprox、isError |
| `error` | turnId、phase、code、sanitizedMessage、agentId?、agentRole?、toolName?、tier?、model? |
| `feature_usage` | feature、enabled、events、toolCalls |
| `benchmark_run` | benchmark、dataset、split、instanceId、passed、durationMs、inputTokens、outputTokens |

- `features` 只含布尔开关：todo/hooks/skills/promptTemplates/webSearch/webFetch/mcp。
- `turn_end` 的 token 汇总覆盖该用户 turn 的整棵 agent 树（main + worker + task），`byTier`/`byModel` 提供拆分。
- `outcome` 为 `success` / `error` / `aborted`；`success` 必须显式观察到 `done(stop)`。
- 批量信封：`{ schemaVersion: 1, kind, appVersion, installId, events }`，单批最多 500 条；`kind` 为 `user` 或 `benchmark`。

### 不采集用户内容

明确禁止上报：prompt/回复文本、工具入参/输出、文件内容、文件路径、命令、URL 查询参数、用户名、仓库名、任务标题。

实现上：

- 采集器只读会话日志的元数据字段（事件类型、时间戳、`usage`、`model`、`tier`、`agentId`）。`assistant_msg.content` 仅用于识别 tool_call 块里的工具名；消息文本、工具入参与工具输出一律不读取、不上报。
- 错误信息只保留机器码与 `sanitizedMessage`；脱敏函数解析失败时丢弃原文返回空串，宁可少报也不透传。
- 工具名、模型名、功能名属于固定枚举/标识，不是用户文本。

## endpoint 与 token

endpoint 解析顺序（`src/runtime.ts`）：

1. `settings.telemetry.endpoint`（空串或纯空白视为「本机未配置」，继续向后回退）
2. 环境变量 `HOTPOT_TELEMETRY_ENDPOINT`
3. `src/defaults.ts` 的 `DEFAULT_TELEMETRY_ENDPOINT`（仓库内默认为部署的 telemetry server 地址）

`settings.telemetry.endpoint` 是可选字符串，schema 不要求非空：空值/空白表示「本机未配置」，交给环境变量与源码常量。空的环境变量会遮挡源码常量（`??` 只跳过 `undefined`），即 `HOTPOT_TELEMETRY_ENDPOINT=""` 等于显式关闭遥测，不会再回退到源码常量。运行时对最终取值做校验：空串、非绝对 URL、非 `http(s)` 协议都视为「未配置」，`createTelemetryRuntime` 返回 `null`；遥测是旁路，无效配置退化为 no-op，不会让 `loadSettings` 抛错或拖垮进程启动。启用后客户端向 `<endpoint>/api/v1/ingest` POST JSON。

token 来自 `settings.telemetry.token`，可以是字面值，也可以是整串 `$ENV` 引用（如 `"$HOTPOT_TELEMETRY_TOKEN"`）。引用不存在或为空时不算错误：照常上报，只是不带 `Authorization` 头；有 token 时发送 `Authorization: Bearer <token>`。

## 开关

- `settings.telemetry.enabled: false` → runtime 为 `null`，全部 no-op。
- 默认为开启；但 endpoint 未配置时同样不启用。
- `settings.telemetry.flushIntervalMs` 取非负整数，默认 `30000`；`0` 表示不定时 flush，只靠阈值（默认 50 条）与 `close()` 触发。负数仍是配置校验错误。
- `telemetry` 只从用户级 `~/.hotpot/settings.json` 读取。项目级 `.hotpot/settings.json` 的 schema 不接受该字段，防止恶意仓库改写上报地址或凭证。

## 安装 ID

- 用户态：`<home>/telemetry/install-id`
- benchmark 态：`<home>/telemetry/benchmark-install-id`（独立文件，避免跑批污染真实设备标识）
- `<home>` 复用 `@hotpot/core` 的 `resolveHome`：显式参数 > `HOTPOT_HOME` > `~/.hotpot`。

首次运行生成随机 UUID，之后一直复用；文件内容不是合法 UUID 时重新生成并覆盖。写入失败（只读目录、磁盘满）只退化为「本次不落盘」，仍返回生成的 ID，绝不抛错。安装 ID 不关联账号、机器名或任何用户信息。

## client 行为

- `enqueue` 同步入队；达到 `maxBatch`（默认 50）立即异步 flush，不阻塞调用方。
- 队列超过 `maxQueue`（默认 1000）时丢最旧事件并计入 `dropped`。
- flush 串行执行，同一批不会被并发重发；失败按 1s / 2s / 4s 退避重试 3 次，仍失败则整批放回队首，等下一次 flush 再试。
- 单请求超时 5s；默认定时器与重试 sleep 都 `unref()`，即使调用方漏调 `close()` 也不会阻止进程退出。
- `close()` 是退出路径，只做一次有界尝试：不重试、不退避，并持有 ref 定时器直到最后一次请求结算，避免事件循环提前排空（Node exit code 13）或用户在 `/exit` 后等待重试链。失败的那批留在队列里，进程退出即丢弃。
- 网络错误、超时、序列化异常都被吞掉，`flush()` / `close()` 永不 reject，只更新 `stats()` 里的计数。

## cli / server 接入点

- `packages/cli/src/chat.ts`：REPL 启动时创建 runtime 并上报 `session_start`；每个 turn 创建 collector，`start` / `observe` / `finish` 后入队，turn 结束 flush；退出时上报 `session_end` 并 `close()`。
- `packages/server/src/session-manager.ts`：`createSessionManager` 创建一个 manager 级 runtime；创建/恢复会话时上报 `session_start`，每个 `runOneTurn` 上报 turn 事件，每个会话的 `close(id)` 时尽力上报 `session_end`。没有 manager 级 close。读取 settings 失败只退化为「遥测关闭」。
- 两个接入点都以 `createTelemetryRuntime` 返回 `null` 表示旁路未启用，后续代码不写额外分支；上报点自身也不在 turn 的失败路径上。

## 测试

`pnpm test` 覆盖：

- `test/events.test.ts`：批次信封、未知字段/未知事件类型拒绝、单批 500 条上限。
- `test/sanitize.test.ts`：绝对路径、带空格路径的残片（POSIX/Windows）、URL 查询串、邮箱、非 web scheme、代码块、长度截断。
- `test/client.test.ts`：批量投递、无 token 时不带 Authorization、失败重试、禁用/空 endpoint、队列溢出、请求超时、`close()` 单次有界尝试（失败与挂起两种）、`flushIntervalMs <= 0` 不注册定时器、定时器 unref。
- `test/runtime.test.ts`：settings endpoint 优先、空/空白 endpoint 回退到环境变量、空环境变量遮挡源码常量并返回 `null`、非法协议返回 `null`。
- `test/install-id.test.ts`：持久化、benchmark 独立 ID、损坏文件重建、只读 home 不抛错。
- `test/collector.test.ts`：turn 折叠（含 worker/task 用量）、feature 计数、损坏日志、outcome 判定、会话生命周期事件。
- `packages/cli/test/telemetry.test.ts`、`packages/server/test/telemetry.test.ts`：端到端 payload 不含对话文本；`enabled=false`、未配置 endpoint（settings 空串会回退，环境变量也为空时按未配置处理）、非法 endpoint 时不发请求；上报 `fetch` 持续抛错时 turn 仍成功、`runChat` 正常返回。
