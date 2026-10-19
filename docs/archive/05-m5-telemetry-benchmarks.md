# M5 遥测体系与 benchmarks

本文汇总 M5 两条工作流的落地方式：工具侧遥测客户端（`packages/telemetry`）与 benchmark runner（`packages/benchmarks`）。设计依据见 `docs/superpowers/specs/2026-10-18-m5-telemetry-benchmarks-design.md`，实施计划见 `docs/superpowers/plans/2026-10-18-m5-benchmarks.md`。

- 遥测客户端：已合入本仓库。
- benchmark runner：已合入本仓库；SWE-bench Lite 10 题验收记录见 `04-roadmap.md` M5.3/M5.4 节。
- 遥测后台 `../hotpot-telemetry/` 是仓库外独立项目，不进入 CLI/server 构建产物。

## 遥测客户端

### 上报链路

```text
cli / server
  └─ createTelemetryRuntime(settings, { kind, home?, fetchImpl? })
       ├─ enabled=false / endpoint 为空或非法 → null（调用方跳过）
       └─ runtime.client / runtime.createCollector(session, { turnId })
            └─ 批量 POST <endpoint>/api/v1/ingest（默认阈值 50 条 / 30s）
```

- endpoint 优先级：`settings.telemetry.endpoint` > `HOTPOT_TELEMETRY_ENDPOINT` > 源码常量（默认空）。
- 空的环境变量会遮挡源码常量，表示显式关闭。
- 安装 ID：`<home>/telemetry/install-id`（用户）与 `<home>/telemetry/benchmark-install-id`（benchmark），互不复用。
- 上报失败只进本地队列重试，不抛错、不阻塞 turn。

### 事件白名单（schema v1）

| 事件 | 允许字段 |
|------|----------|
| `session_start` / `session_end` | sessionId、resumed、时长、turn/error 数、appVersion、os、node、feature 开关 |
| `turn_start` / `turn_end` | turnId、sessionId、planUsed、outcome、durationMs、mainSteps、assistantMessages、worker/task 数、整棵树 input/output token、byTier、byModel |
| `llm_call` | turnId、agentId、agentRole、tier、model、token、cache token、stepIndex |
| `tool_call` | turnId、agentRole、toolName、durationMs、durationApprox、isError |
| `error` | turnId、phase、code、sanitizedMessage、agent/role/tool/tier/model（可选） |
| `feature_usage` | feature、enabled、events、toolCalls |
| `benchmark_run` | benchmark、dataset、split、instanceId、passed、durationMs、inputTokens、outputTokens |

`kind` 为 `user` 或 `benchmark`，后台按 kind 过滤，避免跑批污染用户指标。明确禁止上报：prompt/回复、工具入参/输出、文件内容、路径、命令、URL 查询参数、用户名、仓库名、任务标题。

### 错误脱敏

`sanitizeErrorMessage` 依次处理代码块、URL、邮箱、Windows/UNC/POSIX 绝对路径、含 `/` 或 `\` 的空白分隔 token，恢复归一化 URL，压缩空白并截断到 500 字符。失败时返回空串（fail-closed），绝不转发原文。

## 遥测后台（仓库外）

- 位置：`../hotpot-telemetry/`（与 hotpot-agent 同级），Node 22 + Hono + SQLite + React 管理界面。
- 默认部署：`sell_system`（Ubuntu 24.04，公网 IP），监听 `0.0.0.0:4580`，数据在 `./data/hotpot-telemetry.db`。
- 接口：`POST /api/v1/ingest`（Bearer token、按 event_id 幂等、schema 二次校验）、总览/成本/性能/成功率/错误/安装/会话/告警规则/投递记录/导出。
- 告警：SMTP、通用 webhook、飞书自定义机器人；规则进程内每 60s 评估，冷却期内不重复投递，失败重试 3 次并记录。
- 配置：`.env` 的 `PORT`、`ADMIN_PASSWORD`、`INGEST_TOKEN`、`SMTP_*`、`FEISHU_WEBHOOK_URL`、`DATA_DIR`、`RETENTION_DAYS`。
- 腾讯云安全组需放行 4580（或反代端口）；当前为 HTTP + ingest token，TLS 由 Caddy/nginx 反代后续加。

工具侧配置示例（`~/.hotpot/settings.json`，仅用户级）：

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "http://<sell_system-ip>:4580",
    "token": "$HOTPOT_TELEMETRY_TOKEN"
  }
}
```

## Benchmarks

### 结构

`packages/benchmarks` 是开发/评测工具，`cli`/`server` 不引用，不进入工具产物：

- `WorkspaceProvider`：M5 实现 `CheckoutWorkspaceProvider`（缓存 clone + 每题独立 detached worktree），未来可换容器实现。
- `agent-runner`：临时 HOME、allow-all 审批（`approval/asked`/`decided` 落盘）、plan 自动批准、超时 abort、整棵 agent 树 token 汇总。
- SWE-bench：实例 JSONL → agent 改工作树 → `git add -A -N` + `git diff` → `predictions.jsonl` → 官方 harness。
- custom：三题种子任务（金融 / 软件开发 / 自媒体），离线校验。
- report：`report.json` + `report.md`，只含 id、通过与否、token、时长、脱敏失败原因。
- telemetry：每题一条 `benchmark_run`，独立安装 ID。

### 命令

```bash
# 激活已安装 swebench 的 venv（harness 通过 python3 调用）
source ~/swebench-venv/bin/activate
export HF_ENDPOINT=https://hf-mirror.com

# 导出 Lite 10 题
python packages/benchmarks/scripts/export_instances.py \
  --dataset SWE-bench/SWE-bench_Lite --split test --limit 10 \
  --output instances.jsonl

# 本地跑 agent + 官方评测
pnpm bench swebench --limit 10 --instances-file instances.jsonl \
  --eval-mode local --max-workers 1

# 远程评测（macmini）
pnpm bench swebench --instances-file instances.jsonl \
  --eval-mode remote --eval-host macmini --max-workers 1

# 自建题
pnpm bench custom --domain finance
```

输出默认在 `./benchmark-runs/<时间戳>-<suite>/`，包含 `predictions.jsonl`、`official/`、`report.json`、`report.md`、`cache/`、`workspaces/`。

### patch-only 基线

M5 的 benchmark agent 只生成 patch：普通 checkout，不装 repo 依赖、不执行 repo 测试、不 commit。提示词明确要求离线改文件。因此：

- 通过率是 patch-only 基线，不能与「带测试反馈的完整 agent」直接比较。
- 空 patch 写成空字符串，官方 harness 记为 unresolved，不会伪造成通过。
- 报告与遥测都必须标注该口径。

### 主机分工

| 主机 | 角色 |
|------|------|
| macmini（Apple Silicon，24G/256G） | agent 推理、patch 生成、Docker（amd64 模拟）官方评测 |
| `sell_system`（Ubuntu x86_64，2C/3.5G/47G） | 默认托管遥测后台；macmini 资源不足时作为评测备选 |
| 本机 | 开发、单测；不作为正式跑批环境 |

### 失败恢复

| 现象 | 处理 |
|------|------|
| HuggingFace 下载失败 | `export HF_ENDPOINT=https://hf-mirror.com`，或从可访问机器导出 JSONL 后 `rsync` |
| Docker 拉镜像失败 | 先 `docker pull hello-world` 验证 registry mirror；仍失败则检查 Docker Desktop 代理 |
| Apple Silicon 报 `no matching manifest for linux/arm64` | 预拉 amd64：`docker pull --platform linux/amd64 swebench/sweb.eval.x86_64.<id>:latest`；镜像名用 `make_test_spec(instance).image` 生成（见 `packages/benchmarks/README.md`） |
| harness 打印进度但没有 report | runner 以非 0 退出并打印日志路径；查 `official/<runId>.log`，不当作通过 |
| tmux 不存在 | `evaluate.ts` 自动回退 `nohup`；也可 `brew install tmux` |
| 磁盘不足 | 预检记录镜像大小；磁盘 < 20G 停止，`docker system prune` 后继续 |
| amd64 模拟过慢/内存压力 | 先跑 1 题预检；不可用时把评测移到 `sell_system` 或更大的 Linux 主机 |
| LLM 凭证缺失/不可达 | 不伪造凭证；补齐 `~/.hotpot/settings.json` 或换可达 provider 后重跑 |
| 遥测 endpoint 不可达 | 旁路自动重试/丢弃，不影响跑批；报告仍照常生成 |

### 已知限制

- 不安装 repo 依赖、不跑 repo 测试，因此不覆盖「需要构建/测试反馈」的能力。
- Apple Silicon 上 amd64 镜像模拟可能显著慢于原生 x86_64；swebench 5.x 还需手动 `docker pull --platform linux/amd64` 预拉镜像。
- 默认只跑 Lite 10 题；完整 300 题是手动跑批，需要更多磁盘与时间。
- 官方 report 路径随 harness 版本变化：swebench 5.x 实际写到 `<report_dir>/<model_name>.<runId>.json`；runner 按 `<runId>.json`、`hotpot-agent.<runId>.json`、`<runId>/report.json`、浅层扫描依次查找。
- swebench 5.x 必须使用 `SWE-bench/SWE-bench_Lite`（数据集自带 `image` 字段）；旧名 `princeton-nlp/SWE-bench_Lite` 会让 harness 抛 `KeyError: 'image'`。
