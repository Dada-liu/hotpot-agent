# M5 设计：遥测体系与 benchmarks

> 状态：待用户确认。确认后才进入实现计划（`docs/superpowers/plans/`）。
> 本文覆盖 M5 的两条工作流：工具侧遥测 + 独立遥测后台服务，以及 benchmarks（SWE-bench 官方评测 + 自建三领域题目）。

## 1. 目标

M5 要回答两个问题：

1. 用户在实际使用 hotpot-agent 时，成本、性能、成功率、系统错误是什么状态，能否据此做告警并持续优化项目。
2. hotpot-agent 在标准化 benchmark 和自建领域任务上的通过率与 token 成本是多少，改动后是否变好。

对应 `docs/archive/04-roadmap.md` M5 验收：

1. benchmark 一键运行，输出成功率与平均 token 成本报告。
2. 遥测报表能回答「上周每个任务平均花了多少 token、成功率多少」。
3. 自建 bench 有从历史会话沉淀新题的流程文档（筛选 → 脱敏 → 题目化）。

## 2. 已确认决策

| 决策 | 结论 |
|---|---|
| 上报方式 | 工具主动上报到中心服务 |
| 中心服务归属 | 只由用户一个人部署 |
| 后台服务位置 | 仓库外，`../hotpot-telemetry/`（与 hotpot-agent 同级） |
| 后台与工具关系 | 独立项目，不打进工具的构建产物 |
| 上报地址 | 可配置；用户打包工具前配置好。解析顺序：settings > `HOTPOT_TELEMETRY_ENDPOINT` > 源码常量 |
| 数据边界 | 只上报匿名使用指标与脱敏后的系统错误；禁止任务文本、对话内容、代码、文件路径等用户隐私数据 |
| 错误信息 | 允许上报经过脱敏的错误消息 |
| 告警渠道 | 邮件（SMTP）、通用 webhook、IM；IM 先只做飞书 |
| 任务成功率口径 | 用户一条消息开启一个 task turn；turn 无报错完成记 success，报错记 error，中断单独记 aborted |
| benchmark 验收 | SWE-bench Lite `test` 的 10 题子集 |
| benchmark 评测 | 官方数据集 + 官方 `swebench` harness + Docker，不自研评测 |
| benchmark agent 范围 | M5 只生成 patch，不要求在 repo 内安装依赖或执行测试；runner 留 `WorkspaceProvider` 接口，后续可切到容器内运行 |
| benchmark 审批 | runner 显式安装 allow-all 工具审批 handler，plan 自动 approve，审批事件落盘审计；不使用 `policy=never` |
| 数据集导出 | 在 macmini 的 Python venv 导出 JSONL（`HF_ENDPOINT=https://hf-mirror.com`），或从 `sell_system` 同步 |
| 主机分工 | Mac mini 跑 agent 推理、patch 生成与官方 Docker 评测；`sell_system` 默认托管遥测后台服务（有公网 IP） |
| Mac mini | `ssh macmini`，Apple Silicon macOS 26.5，24G/256G，Docker Desktop 已装并配置 registry mirror |
| `sell_system` | `ssh sell_system`，Ubuntu 24.04 x86_64，Docker 27.5.1，2C/3.5G/47G 可用 |

## 3. 非目标与 anti-goals

非目标：

- 不做多租户 SaaS、账号体系、团队隔离；只有单操作员。
- 不采集、不上报任何用户内容（prompt、回复、工具入参/输出、文件内容、命令、路径）。
- 不重新实现 SWE-bench 评测逻辑；只做 runner 与官方 harness 的编排。
- 不在 M5 引入实时流式遥测或进程内唤醒；上报是异步批量。
- M5 不让 benchmark agent 在 repo 内跑测试；这是 patch-only 基线，不是带测试反馈的完整 agent。

anti-goals（做了就算失败）：

- 遥测阻塞 agent 主流程，或上报失败导致 turn 失败。
- 上报数据能反向还原用户任务、代码或文件结构。
- benchmark runner 用 mock 通过但无法跑真实 LLM 与官方评测。
- 后台服务被打进 CLI/server 的构建产物。

## 4. 总体架构

```text
┌──────────────────────────────┐
│ hotpot-agent (用户机器)       │
│  cli / server                 │
│    └─ @hotpot/telemetry 客户端 │
│         · 事件采集与脱敏       │
│         · 本地队列/批量/重试   │
│         · installId           │
└──────────────┬───────────────┘
               │ HTTPS/HTTP POST（可配置 endpoint + ingest token）
               ▼
┌──────────────────────────────────┐
│ ../hotpot-telemetry (默认 sell_system) │
│  ingest API → SQLite              │
│  aggregations → admin API         │
│  React 管理界面                   │
│  alert scheduler → SMTP/         │
│    webhook/飞书                   │
└──────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ macmini                                                     │
│  packages/benchmarks runner                                 │
│  · 准备仓库 / 跑 agent / 生成 predictions.jsonl             │
│  · swebench venv + Docker（amd64 模拟）→ 官方评测            │
│  · report.json                                              │
└────────────────────────────────────────────────────────────┘
```

## 5. 遥测数据模型与隐私

### 5.1 事件信封

每条事件带 `eventId`（UUID）、`ts`、`schemaVersion`。客户端批量发送：

```json
{
  "schemaVersion": 1,
  "kind": "user",
  "appVersion": "0.0.0",
  "installId": "uuid",
  "events": []
}
```

- `kind`：`"user"`（正常使用）或 `"benchmark"`（跑批）。后台可按 kind 过滤，避免 benchmark 数据污染用户指标。
- `installId`：首次运行生成的随机 UUID，持久化在 `<home>/telemetry/install-id`，不关联账号或机器名。benchmark 使用独立的安装 ID，不复用用户的。
- `sessionId`：复用会话日志的随机 UUID，只用于去重与聚合。

### 5.2 允许上报的字段

| 事件 | 字段 |
|---|---|
| `session_start` / `session_end` | sessionId、resumed、时长（best-effort）、turn 数、error 数、appVersion、os、node 版本、feature 开关 |
| `turn_start` / `turn_end` | turnId、sessionId、planUsed、outcome(success/error/aborted)、durationMs、mainSteps、assistantMessages、workerCount、taskCount、inputTokens、outputTokens、byTier、byModel（整棵 agent 树） |
| `llm_call` | turnId、agentId、agentRole、tier、model、inputTokens、outputTokens、cacheReadTokens、cacheWriteTokens、stepIndex |
| `tool_call` | turnId、agentRole、toolName、durationMs、durationApprox、isError |
| `error` | turnId、phase、code、sanitizedMessage、agentId?、agentRole?、toolName?、tier?、model? |
| `feature_usage` | feature、enabled、events、toolCalls |
| `benchmark_run` | benchmark、dataset、split、instanceId、passed、durationMs、inputTokens、outputTokens |

明确禁止：prompt/回复文本、工具入参/输出、文件内容、文件路径、命令、URL 查询参数、用户名、仓库名、任务标题。

`turn_end` 的 totals 覆盖该用户 turn 触发的整棵 agent 树（main + worker + task）；`byTier`/`byModel` 提供拆分，保证「平均每任务 token」和「按模型成本」不低估。`mainSteps` 是 main agent 的 step 数；`assistantMessages` 是整棵树落盘的 assistant 消息数。

### 5.3 错误脱敏

客户端统一走 `sanitizeErrorMessage`：

- 去掉绝对路径与 home 目录，替换为 `<path>`。
- 去掉 `user@host`、URL 查询参数与片段，只保留 scheme+host+path 的归一化形式。
- 去掉代码块、长引号文本与换行后的调用栈细节；保留错误类型、归一化消息、可选 `at <function>` 帧。
- 截断到 500 字符。
- 服务端再次按白名单 schema 校验，未知字段直接丢弃。

### 5.4 成功 / 失败 / 中断判定

一个 task turn = 用户一条消息触发的完整回合，包含 main、worker、task 三层。

- `success`：main 回合以 `done(stop)` 结束；该 turn 树内没有 `error` 事件；没有被用户中断；有 plan 时 plan 已批准。
- `error`：该 turn 树内任意 agent 出现 `error` 事件、main 以 `done(error)` 结束、`done(max_tokens)`、plan 修订耗尽、或回合意外结束。工具返回 `isError` 本身不算 error（agent 可以恢复）；工具失败单独计入工具成功率。
- `aborted`：用户中断，或用户拒绝 plan。单独展示，不计入成功率分母。
- 子 agent 的 LLM/系统错误即使被折叠成 worker 摘要，也通过会话日志里的 `error` 事件计入该 turn 的 error 判定。
- 工具调用失败但 agent 最终正常完成：turn 记 success，工具成功率的分子/分母单独反映这次失败。

### 5.5 会话生命周期

- `session_start` 只在新建会话时发送（`resumed: false`）；`--session` 恢复或 server `attachById` 发送 `resumed: true`，后台按 sessionId 合并，不重复计活跃会话。
- `session_end` 是 best-effort：CLI 进程退出、`manager.close()` 或会话空闲 30 分钟时发送。server 长期不关闭时由后台按最后事件时间计算活跃/结束状态，不依赖 `session_end` 一定到达。

## 6. 工具侧：`packages/telemetry`

新增 workspace 包 `@hotpot/telemetry`，被 `cli`、`server`、`benchmarks` 引用，不进入 `core` 或 `orchestrator` 的依赖。

模块：

- `src/defaults.ts` — `DEFAULT_TELEMETRY_ENDPOINT` 源码常量（默认空）。仓库当前没有发布构建链，打包前由打包者改这个常量或设置环境变量；运行时 settings 优先级最高。
- `src/events.ts` — 事件类型与 zod schema（schemaVersion = 1）。
- `src/sanitize.ts` — 错误消息脱敏。
- `src/install-id.ts` — 安装 ID 持久化（复用 `resolveHome`）；支持 `kind=benchmark` 的独立 ID。
- `src/client.ts` — `createTelemetryClient(opts)`：
  - 内存队列 + 定时/阈值 flush；`flush()` 幂等。
  - 批量 POST；失败指数退避重试；超过队列上限丢最旧并计数。
  - 单次请求超时 5s；`AbortSignal` 不影响进程退出。
  - `enabled=false` 或 endpoint 为空时全部 no-op。
  - `fetchImpl` 可注入，测试不触网。
- `src/collector.ts` — `TelemetryCollector`：
  - 观察 `OrchestrationEvent`：main agent 的 `tool_call`/`tool_result` 按事件顺序与 id 计时；`done`/`error` 判定 main 回合结果；`agent_spawn` 计数。
  - turn 结束后从会话日志折叠整棵 agent 树：`assistant_msg.usage`/model/tier/agentId 生成 `llm_call` 与 `turn_end.byTier`/`byModel`；`tool_result` 通过 `toolCallId` 匹配 `assistant_msg` 里的 tool_call 块，持续时间按 `assistant_msg.ts → tool_result.ts` 近似，标记 `durationApprox: true`。
  - 不修改 v1 会话事件契约；worker/task 的工具统计来自日志折叠，不依赖迭代器。
  - 只产出白名单字段，不接触事件内容。
- `src/index.ts` — barrel。

配置（`packages/core/src/config/config.ts`，仅用户级）：

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "http://<sell_system-ip>:4580",
    "token": "$HOTPOT_TELEMETRY_TOKEN",
    "flushIntervalMs": 30000
  }
}
```

- `enabled` 默认 true（遵循 docs）；endpoint 解析顺序：settings > `HOTPOT_TELEMETRY_ENDPOINT` > `DEFAULT_TELEMETRY_ENDPOINT`。
- `telemetry` 仅用户级，项目级 schema 不接受，防止恶意仓库把数据引到别处。

接入点：

- `packages/cli/src/chat.ts`：创建 client + collector，包装 `runMainTurn` 事件迭代器；turn 结束 flush；进程退出 flush。
- `packages/server/src/session-manager.ts`：同一套 collector，按会话/turn 上报；SSE 瞬态事件与 durable 日志都不改。
- `packages/benchmarks/src/telemetry.ts`：benchmark 事件，`kind=benchmark`，独立 installId。
- 两个用户接入点共享 `@hotpot/telemetry`，不重复实现。

## 7. 中心服务：`../hotpot-telemetry`

### 7.1 技术选型

- Node 22 + TypeScript（erasable syntax）。
- HTTP：Hono（与 `packages/server` 一致）。
- 存储：SQLite（`better-sqlite3`），单文件 + WAL；数据量小，单操作员足够。
- 管理界面：React + Vite + Tailwind，独立静态产物，由同一 Node 进程托管。
- 校验：zod。
- 邮件：`nodemailer`（SMTP）。
- IM：飞书自定义机器人 webhook；通用 webhook 直接 POST JSON。
- 测试：vitest；不触真实 SMTP/飞书。

### 7.2 目录

```text
../hotpot-telemetry/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── AGENTS.md
├── src/
│   ├── server/        # Hono 路由、认证、静态托管
│   ├── db/            # schema、迁移、聚合查询
│   ├── ingest/        # 批量校验、去重、脱敏复核
│   ├── alerts/        # 规则评估、渠道发送、冷却与投递记录
│   └── shared/        # 事件 schema（与工具侧保持同版本）
├── web/               # React 管理界面
├── test/
└── scripts/           # 启动、备份、迁移
```

### 7.3 数据表

- `telemetry_events`：`event_id` 主键、`type`、`kind`、`install_id`、`session_id`、`turn_id`、`ts`、`received_at`、`payload_json`。索引：`(type, ts)`、`(kind, ts)`、`(install_id, ts)`、`(session_id)`。
- `installations`：install_id、kind、first_seen、last_seen、app_version、os、node。
- `alert_rules`：name、metric、window_minutes、comparator、threshold、cooldown_minutes、channels_json、enabled。
- `alert_events`：rule_id、triggered_at、value、state（firing/resolved）、payload_json。
- `deliveries`：alert_event_id、channel、target、status、attempts、last_error、sent_at。
- `admin_sessions`：登录会话（签名 cookie）。
- `ingest_tokens`：可选；M5 先用环境变量单 token。

原始事件保留 30 天（可配）；每日 rollup 保留 365 天。rollup 由启动时与每小时任务生成。

### 7.4 API

- `POST /api/v1/ingest`：Bearer token；单批 ≤ 1MB / 500 条；按 `event_id` 幂等；逐条 schema 校验；返回 `{accepted, rejected}`。速率限制按 IP + installId。
- `POST /api/v1/login`、`POST /api/v1/logout`：单操作员密码（`ADMIN_PASSWORD`）。
- `GET /api/v1/overview?range=24h|7d|30d&kind=user|benchmark`：turn 数、success/error/aborted、token、p50/p95 时长、活跃 install 数。
- `GET /api/v1/cost`：按日/install/model/tier 的 input/output token 与估算成本。
- `GET /api/v1/performance`：turn 时长、tool 时长、steps 分布。
- `GET /api/v1/success`：任务成功率、工具成功率，按版本/模型/install 聚合。
- `GET /api/v1/errors`：按 code/消息聚合与趋势；消息已是脱敏文本。
- `GET /api/v1/installs`、`GET /api/v1/sessions`：安装与会话列表（只展示指标）。
- `GET/POST/PATCH/DELETE /api/v1/alert-rules`；`POST /api/v1/alert-rules/:id/test`；`GET /api/v1/deliveries`。
- `GET /api/v1/export?format=csv|json`：按当前筛选导出报表。
- `GET /healthz`。

估算成本使用服务端可配置的模型价格表（env 或 `pricing.json`）；没有价格的模型只展示 token。

### 7.5 管理界面

页面：登录、总览、成本、性能、成功率、错误、安装列表、告警规则、投递记录、导出。默认时间范围 7 天；所有图表支持按 appVersion / model / tier / install / kind 过滤。界面只读指标，不展示任何用户内容。

### 7.6 告警

- 规则：metric（success_rate、error_rate、p95_turn_duration、turn_tokens、no_data）、window、comparator、threshold、cooldown、channels。
- 调度：进程内每 60s 评估；规则命中后进入 firing，恢复后 resolved；冷却期内不重复发送。
- 渠道：
  - SMTP：`SMTP_HOST/PORT/USER/PASS/FROM/TO`。
  - 通用 webhook：POST JSON `{rule, state, value, window, firedAt, summary}`。
  - 飞书：自定义机器人 webhook，文本卡片消息。
- 投递失败重试 3 次并记录 `deliveries`；后台展示失败原因。

### 7.7 部署

- 默认监听 `0.0.0.0:4580`（`PORT` 可配），SQLite 在 `./data/hotpot-telemetry.db`。
- 部署主机默认 `sell_system`（公网 IP）；若改放 macmini（LAN 192.168.1.180），需要隧道或公网端口映射，工具 endpoint 指向映射后的地址。
- `.env.example` 列出 `PORT`、`ADMIN_PASSWORD`、`INGEST_TOKEN`、`SMTP_*`、`FEISHU_WEBHOOK_URL`、`DATA_DIR`、`RETENTION_DAYS`。
- 提供 `docker-compose.yml`（挂载 `./data`）与 `systemd` 示例；`sell_system` 上优先 Docker Compose。
- 部署在 `sell_system` 时腾讯云安全组需放行 4580（或反代端口）；公网 HTTP + ingest token；TLS 由 Caddy/nginx 反代后续加。
- 备份：SQLite 文件 + WAL checkpoint；`scripts/backup.sh`。

## 8. Benchmarks

### 8.1 `packages/benchmarks`

新增 workspace 包 `@hotpot/benchmarks`，只作为开发/评测工具，不被 `cli`/`server` 引用，不进入工具产物。允许依赖 `@hotpot/telemetry`（`kind=benchmark`）。

模块：

- `src/cli.ts` — `pnpm bench <suite> [options]`；参数：`--limit`、`--instance-ids`、`--instances-file`、`--dataset`、`--split`、`--model-tier`、`--workspace-root`、`--output`、`--eval-mode local|remote`、`--eval-host macmini`、`--max-workers`。
- `src/workspace.ts` — `WorkspaceProvider` 接口：`prepare(instance) → { cwd, cleanup() }`。M5 实现 `CheckoutWorkspaceProvider`（git clone + checkout，不装依赖）；后续可加 `ContainerWorkspaceProvider`，上层 runner 不变。
- `src/agent-runner.ts` — 无交互跑一个 task turn：
  - 用 `@hotpot/core` 的 `loadSettings`/`createSession` 与 `@hotpot/orchestrator` 的 `createRuntime`/`runMainTurn`。
  - 临时 `HOTPOT_HOME`，避免污染用户会话。
  - 安装显式 allow-all `ApprovalChain` handler（工具审批全部 allow，落盘 asked/decided 供审计）；plan 自动 approve。不要使用 `approval.policy = "never"`——在该实现里它等于没有 handler，所有审批会被 fail-closed 拒绝。
  - 超时与 abort；只回收最终 patch、usage、错误码。
- `src/swebench/instances.ts` — 读取官方数据集切片：
  - 在 macmini 的 `swebench` venv 里运行 `scripts/export_instances.py`（使用 `datasets`，`HF_ENDPOINT=https://hf-mirror.com`）导出选中实例 JSONL；runner 也支持直接读 `--instances-file`。
  - 支持 `--limit 10`、`--instance-ids`、固定随机种子。
- `src/swebench/workspace.ts` — 基于 `WorkspaceProvider` 的 SWE-bench 实现：按 `repo`/`base_commit` 克隆并 checkout；仓库缓存复用；`git add -A -N` 后 `git diff` 生成 patch；排除 `.hotpot`、`node_modules`、benchmark 自身文件。
- `src/swebench/predictions.ts` — 输出官方格式 JSONL：`instance_id`、`model_name_or_path`、`model_patch`。
- `src/swebench/evaluate.ts` — 调用官方 harness：
  - local：`python -m swebench.harness.run_evaluation ...`
  - remote：`rsync` predictions 到 `--eval-host`（默认 macmini），在 tmux 中跑 harness，轮询日志，回收 report。
  - 参数：`--dataset_name`（默认 Lite）、`--split test`、`--max_workers 1`、`--run_id`、`--report_dir`。
- `src/custom/` — 自建 bench 格式与 runner（见 8.3）。
- `src/report.ts` — 解析官方 report 与 custom 结果，输出 `report.json` + Markdown/CSV：pass rate、平均 input/output token、平均时长、失败 instance 列表。
- `src/telemetry.ts` — 把 `benchmark_run` 事件上报到中心服务（独立 installId，`kind=benchmark`）。

### 8.2 SWE-bench 流程

1. `pnpm bench swebench --limit 10 --dataset princeton-nlp/SWE-bench_Lite --split test`（数据集名以官方 harness 版本为准，可配）。
2. 在 macmini 的 Python venv 导出 10 条实例 JSONL（`HF_ENDPOINT=https://hf-mirror.com`），或从 `sell_system` 导出后同步过来。
3. runner 在 macmini 上准备普通 checkout（只保证 git、源码和写权限，不安装 repo 依赖），逐题跑 agent，生成 `predictions.jsonl`。
4. `--eval-host macmini`：在 macmini 的 Python venv 中调用官方 harness，Docker Desktop（amd64 模拟）逐题评测；镜像通过 Docker Desktop registry mirror 拉取。
5. 回收 report，输出 pass rate 与 token 成本；失败题列出 instance_id 与失败原因（不包含用户内容）。
6. 默认 `--max-workers 1`；先跑 1 题做预检，记录镜像大小、内存峰值、amd64 模拟耗时；磁盘低于 20G 或镜像积累超过阈值时停止并提示清理；每 10 题清理未使用镜像。
7. 完整 Lite 300 题作为手动跑批；默认验收只跑 10 题。
8. 如果 macmini 的 amd64 模拟或资源不足，回退方案依次为：把评测移到 `sell_system`（需解决 Docker Hub 访问）→ 更大的 Linux 主机。预检结果写入 report。

### 8.3 自建三领域 bench

任务格式（JSON）：

```json
{
  "id": "finance-daily-returns",
  "domain": "finance",
  "prompt": "Read prices.csv and write returns.json ...",
  "workspace": { "files": { "prices.csv": "..." } },
  "validation": { "command": "node check.mjs", "expectedExitCode": 0 },
  "timeoutMs": 300000
}
```

- 每题一个临时 workspace；agent 可用 bash/read/write/edit。
- 校验命令退出码为 0 且可选的 stdout 匹配记为 passed。
- 先落三题：
  - 金融：读 CSV 计算日收益率并写 JSON，校验数值与 schema。
  - 软件开发：实现一个小函数并通过自带测试。
  - 自媒体运营：按约束生成结构化内容计划 JSON，校验字段、长度与关键词。
- 题目离线、确定性、无网络。
- 新题沉淀流程单独成文（见 10.6）。

## 9. 测试体系

- `packages/telemetry/test/`：schema、脱敏、批量/重试、安装 ID、turn outcome、会话生命周期、禁用开关、无内容字段断言。
- `packages/benchmarks/test/`：custom task runner（scripted adapter）、`WorkspaceProvider` 与 checkout patch 生成、allow-all 审批、predictions 格式、report 解析、数据集切片、remote 命令构造（不真连 SSH）。
- `packages/server/test/`：scripted adapter 下 telemetry collector 的端到端 payload；断言不含事件内容，且 turn totals 覆盖 worker/task。
- 录制回放：在 `@hotpot/ai` 的 scripted adapter 基础上补一个最小的 `record`/`replay` 测试辅助（JSONL），CI 全 mock，不触网。
- `../hotpot-telemetry/test/`：ingest 校验/幂等、聚合 SQL、告警评估、渠道发送（stub）、登录鉴权、kind 过滤。
- 不新增测试依赖；沿用 vitest。

## 10. 文档

1. 本文（设计文档）。
2. `docs/PRD.md`：M5 范围、遥测隐私边界、后台服务不进入工具产物。
3. `docs/archive/02-architecture.md`：新增 `packages/telemetry`、`packages/benchmarks`，遥测数据流与部署拓扑。
4. `docs/archive/04-roadmap.md`：M5 验收细化（Lite 10 题、主机分工、告警渠道、patch-only 基线）。
5. 新增 `docs/archive/05-m5-telemetry-benchmarks.md`：事件 schema、后台 API/部署、benchmark 操作手册。
6. 新增 `docs/benchmark-authoring.md`：从历史会话筛选 → 脱敏 → 题目化的流程。
7. `docs/README.md` 阅读顺序更新。
8. 新包 README/AGENTS；`../hotpot-telemetry/README.md` + `AGENTS.md`；根 README 目录树与包列表。
9. `docs/superpowers/README.md` / `AGENTS.md` 增加 `specs/`。

## 11. 实施顺序

1. M5.1 遥测客户端：配置、事件 schema、脱敏、批量重试、CLI/server 接入、单测。
2. M5.2 遥测后台：ingest + SQLite + 聚合 API + 管理界面 + 告警；本地跑通后部署到 `sell_system`，用本机工具上报验证。
3. M5.3 benchmark runner：custom 三题 + 单测；SWE-bench 数据集切片、workspace、predictions。
4. M5.4 官方评测：macmini 安装 venv + `swebench`；跑 Lite 10 题；Docker Desktop 使用 registry mirror 拉 amd64 镜像；回收 report；输出成本与通过率。
5. M5.5 测试补齐、文档、验收报告。

## 12. 验收映射

| 验收 | 证据 |
|---|---|
| benchmark 一键运行并输出成功率与 token 成本 | `pnpm bench swebench --limit 10` 生成 `report.json` + Markdown；含 pass rate、平均 token、失败列表；报告标注 patch-only 基线 |
| 遥测报表回答「上周每任务平均 token、成功率」 | 后台总览/成本/成功率页面与 `/api/v1/overview?range=7d` |
| 自建 bench 沉淀流程文档 | `docs/benchmark-authoring.md` |
| 只上报匿名指标与脱敏错误 | schema 白名单、脱敏测试、服务端二次校验、payload 断言 |
| 告警可配置邮件/webhook/飞书 | 告警规则页 + 投递记录 + stub 测试 |
| 后台不进入工具产物 | 后台在 `../hotpot-telemetry/`，`@hotpot/cli`/`@hotpot/server` 依赖树不含它 |

## 13. 构建者需要知道的环境前提

- macmini：安装 Node 22 + pnpm（nvm 或 Homebrew）；Docker Desktop 已安装并配置 registry mirror；能访问 LLM provider（DeepSeek 直连，OpenAI/Anthropic 需代理）。
- macmini 的 Docker Desktop 分配 8G 内存 / 10 核 / 156G 可用；先跑 1 题预检，记录 amd64 模拟耗时与镜像占用。
- HuggingFace 数据集走 `HF_ENDPOINT=https://hf-mirror.com`；Docker Hub 走 Docker Desktop registry mirror，先用 `docker pull hello-world` 验证。
- `sell_system`：默认托管遥测后台；安全组放行 4580（或反代端口）。如果 macmini 网络或资源不足，也作为官方评测的备选主机。
- LLM 凭证：使用用户级 `~/.hotpot/settings.json`；benchmark 跑批单独使用临时 home，避免污染真实会话。
- 遥测后台的 SMTP 与飞书 webhook 由用户在 `.env` 配置；未配置时告警规则可保存但不投递。
- 首次部署需要在部署主机上创建 `data/` 目录并挂载持久化卷。

## 14. 由构建者决定的事项

- 后台 UI 的具体图表与布局。
- SQLite 索引与 rollup 的具体实现。
- 告警规则的默认模板（如 error_rate > 5%、success_rate < 80%）。
- benchmark 10 题的具体 instance 选择（固定种子，结果可复现）。
- 自建三题的具体题面与校验脚本。
- 录制回放辅助的具体文件格式。
- `WorkspaceProvider` 的接口细节与未来容器实现的边界。
- 遥测后台最终部署主机（默认 `sell_system`；若 macmini 有公网映射也可改）。
