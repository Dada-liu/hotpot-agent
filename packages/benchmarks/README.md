# `@hotpot/benchmarks`

M5 benchmark runner：在真实仓库上跑无交互 agent 生成 patch，调用官方 `swebench` harness 评分，输出通过率与 token 成本；另有三个离线种子任务覆盖金融、软件开发、自媒体。

本包是开发/评测工具：`cli` 与 `server` 不引用它，也不进入工具构建产物。评测逻辑不在这里实现——评分全部交给官方 harness。

## 模块

| 文件 | 职责 |
|------|------|
| `src/cli.ts` / `src/cli-args.ts` | `pnpm bench` 入口与参数解析 |
| `src/agent-runner.ts` | 无交互跑一个 task turn：临时 HOME、allow-all 审批（落盘审计）、plan 自动批准、超时 abort、整棵树 token 汇总 |
| `src/workspace.ts` | `WorkspaceProvider` / `Workspace` 接口（未来容器 runner 的缝） |
| `src/swebench/workspace.ts` | `CheckoutWorkspaceProvider`：仓库缓存 + 每题独立 git worktree；`capturePatch` 生成 diff |
| `src/swebench/instances.ts` | 实例 JSONL 解析与确定性选择（limit / instance ids / seed） |
| `src/swebench/predictions.ts` | 官方预测 JSONL（`instance_id` / `model_name_or_path` / `model_patch`） |
| `src/swebench/evaluate.ts` | 官方 harness 编排：local 直接执行，remote 经 rsync + tmux（无 tmux 回退 nohup）；report 解析 |
| `src/custom/task.ts` | 自建题 schema 与目录加载 |
| `src/custom/tasks/*.json` | 三题种子任务（金融 / 软件开发 / 自媒体） |
| `src/custom/runner.ts` | 自建题执行：临时 workspace + 校验命令 |
| `src/report.ts` | `report.json` / `report.md`：通过率、平均 token、平均时长、失败列表 |
| `src/telemetry.ts` | `benchmark_run` 事件（`kind=benchmark`，独立安装 ID） |
| `src/process.ts` | 子进程执行辅助（超时、输出捕获、流式日志回调） |
| `scripts/export_instances.py` | 用 `datasets` 从 HuggingFace 导出实例 JSONL |

## 前置条件

- Node >= 22、pnpm。
- SWE-bench 评测需要 Python 3.11/3.12 的 venv 与 `swebench`：`python -m venv ~/swebench-venv && ~/swebench-venv/bin/pip install swebench`。
- 评测需要 Docker；Apple Silicon 上用 Docker Desktop 的 amd64 模拟，先 `docker pull hello-world` 验证 registry mirror。
- HuggingFace 访问：`export HF_ENDPOINT=https://hf-mirror.com`（导出脚本默认已设置镜像，可显式覆盖）。
- LLM 凭证：用户级 `~/.hotpot/settings.json`（三档模型）。benchmark 的会话写在临时 HOME，不会污染真实会话；但模型配置复用用户级 settings。

## SWE-bench

```bash
# 0. 激活已安装 swebench 的 venv（harness 通过 python3 调用）
source ~/swebench-venv/bin/activate
export HF_ENDPOINT=https://hf-mirror.com

# 1. 导出实例（在已装 datasets 的 venv 中执行）
python packages/benchmarks/scripts/export_instances.py \
  --dataset princeton-nlp/SWE-bench_Lite --split test --limit 10 \
  --output instances.jsonl

# 2. 生成 patch 并调用官方评测（默认 max_workers=1）
pnpm bench swebench \
  --limit 10 \
  --instances-file instances.jsonl \
  --eval-mode local \
  --max-workers 1

# 远程评测（例如在 macmini 上跑 Docker）
pnpm bench swebench --instances-file instances.jsonl --eval-mode remote --eval-host macmini
```

默认数据集 `princeton-nlp/SWE-bench_Lite`、split `test`、seed 0；`--instance-ids a,b` 可指定题目并保持顺序。

输出目录（默认 `./benchmark-runs/<时间戳>-swebench/`）：

```text
<output>/
├── predictions.jsonl      # 官方预测格式（空 patch 也保留一行）
├── official/              # harness 日志、exit-code、官方 report
├── report.json            # 聚合报告
├── report.md              # 人读报告
├── cache/                 # 仓库缓存（跨题复用）
└── workspaces/            # 每题 worktree，跑完即清理
```

### Apple Silicon 与 Docker

`swebench` 5.x 通过 docker-py 拉镜像时不传 platform；在 Apple Silicon 上直接跑会报 `no matching manifest for linux/arm64/v8`。评测前用官方镜像名手动预拉 amd64 版本，harness 检测到本地镜像后就不再 pull：

```bash
docker pull --platform linux/amd64 \
  swebench/sweb.eval.x86_64.<instance_id 的 __ 替换为 _1776_>:latest
```

镜像名可由 harness 自身计算（避免手拼）：

```bash
~/swebench-venv/bin/python - <<'PY'
import json
from datasets import load_dataset
from swebench.harness.utils import make_test_spec

ids = [json.loads(line)["instance_id"] for line in open("instances.jsonl")]
rows = {row["instance_id"]: row for row in load_dataset("SWE-bench/SWE-bench_Lite", split="test")}
for iid in ids:
    print(iid, make_test_spec(rows[iid]).image)
PY
```

- 单个 Lite 镜像约 4GB；预检记录磁盘与内存，磁盘低于 20G 时停止并 `docker system prune`。
- 预拉耗时与镜像层大小相关（实测 4.16GB / 约 3 分 20 秒）；amd64 模拟下单个 astropy 题约 7 分钟，容器内存峰值约 235MB（Docker VM 8GB 足够）。
- 评测机器是 x86_64 Linux 时不需要这一步。

### patch-only 基线

M5 的 agent 只改工作树：不安装 repo 依赖、不执行 repo 测试、不 commit。提示词额外要求「不要装依赖/不要跑测试」。因此通过率是 patch-only 基线，不是带测试反馈的完整 agent；`report.md` 会显式标注。空 patch 会写成空串，由官方 harness 记为 unresolved，不会伪造通过。

## 自建三题

```bash
pnpm bench custom                # 三题全跑
pnpm bench custom --domain finance
```

三题都离线、确定性、无网络，校验命令是 workspace 内的 `check.mjs`（退出码 + `expectedStdout`）。题目格式与沉淀流程见 `docs/benchmark-authoring.md`。

## 报告

`report.json` / `report.md` 只包含：suite、dataset/split、instance id、pass/fail、input/output token、时长、脱敏后的失败原因。不写 prompt、回复、patch 或文件内容；失败原因经 `sanitizeErrorMessage` 去除路径/URL/邮箱后再截断。

有官方 report 时，pass/fail 以官方 `resolved` 列表为准；runner 自己的结果只用于对照与失败原因。

## 遥测

每题结束后向遥测后台发一条 `benchmark_run`（`kind=benchmark`，独立安装 ID），字段仅：benchmark、dataset、split、instanceId、passed、durationMs、inputTokens、outputTokens。遥测关闭、endpoint 为空或网络失败都不影响跑批与报告。

## 测试

全部测试 hermetic：脚本化适配器、临时 git 仓库、临时 HOME，不触网、不跑 Docker/SSH。真实跑批是手动操作，不进入 `pnpm test`。

```bash
pnpm test
pnpm typecheck
pnpm exec biome check .
```
