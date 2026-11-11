# `@hotpot/benchmarks`

M5 benchmark runner：在真实仓库上跑无交互 agent 生成 patch，调用官方 `swebench` harness 评分，输出通过率与 token 成本；另有三类离线任务（金融、软件开发、自媒体），题量随沉淀持续增加。

本包是开发/评测工具：`cli` 与 `server` 不引用它，也不进入工具构建产物。评测逻辑不在这里实现——评分全部交给官方 harness。

## 模块

| 文件                                 | 职责                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `src/cli.ts` / `src/cli-args.ts` | `pnpm bench` 入口与参数解析                                                                               |
| `src/agent-runner.ts`              | 无交互跑一个 task turn：临时 HOME、allow-all 审批（落盘审计）、plan 自动批准、超时 abort、整棵树 token 按档位汇总 |
| `src/runtime-profile.ts`           | 运行档：特性开关、并行数、审批、超时、patch-only 的唯一来源；`BENCHMARK_RUNTIME` 是当前基线 |
| `src/manifest.ts`                  | 运行清单 `manifest.json`：代码版本、模型指纹、运行档、题目集哈希，以及可比较性判定 |
| `src/shard.ts`                     | `--shard i/n`：确定性交错分片（同一 selection 永远切出同一子集，所有分片恰好覆盖全集） |
| `src/merge.ts`                     | `bench merge`：校验可比性后把分片合成一轮；条件不同或题重叠一律拒绝 |
| `src/doctor.ts`                    | `bench doctor`：跑批前预检（模型配置、题目集、磁盘、docker、swebench、HF 镜像、遥测） |
| `src/tokens.ts`                    | 按模型档位累加 usage（成本归因的纯函数） |
| `src/workspace.ts`                 | `WorkspaceProvider` / `Workspace` 接口（未来容器 runner 的缝）                                          |
| `src/swebench/workspace.ts`        | `CheckoutWorkspaceProvider`：仓库缓存 + 每题独立 git worktree；`capturePatch` 生成 diff                 |
| `src/swebench/instances.ts`        | 实例 JSONL 解析与确定性选择（limit / instance ids / seed）                                                  |
| `src/swebench/predictions.ts`      | 官方预测 JSONL（`instance_id` / `model_name_or_path` / `model_patch`）                                |
| `src/swebench/evaluate.ts`         | 官方 harness 编排：local 直接执行，remote 经 rsync + tmux（无 tmux 回退 nohup）；report 解析                |
| `src/custom/task.ts`               | 自建题 schema 与目录加载                                                                                    |
| `src/custom/tasks/*.json`          | 三类种子任务（金融 / 软件开发 / 自媒体），一题一文件                                                        |
| `src/custom/runner.ts`             | 自建题执行：临时 workspace + 校验命令                                                                       |
| `src/report.ts`                    | `report.json` / `report.md`：通过率、均值/中位数/p90、分档位 token、失败列表，内嵌运行清单             |
| `src/telemetry.ts`                 | 一轮跑批的 `benchmark_run` 批量上报（`kind=benchmark`，独立安装 ID，按 200 条一批）                 |
| `src/failure.ts`                   | 失败分类：把自由文本归成 `empty_patch` / `agent_aborted` / `max_tokens` 等枚举                    |
| `src/process.ts`                   | 子进程执行辅助（超时、输出捕获、流式日志回调）                                                              |
| `scripts/export_instances.py`      | 用 `datasets` 从 HuggingFace 导出实例 JSONL                                                               |

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
python benchmarks/scripts/export_instances.py \
  --dataset SWE-bench/SWE-bench_Lite --split test --limit 10 \
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

默认数据集 `SWE-bench/SWE-bench_Lite`（swebench 5.x 起官方仓库名；数据集自带镜像名，旧名 `princeton-nlp/SWE-bench_Lite` 缺 `image` 字段会导致 harness KeyError）、split `test`、seed 0；`--instance-ids a,b` 可指定题目并保持顺序。

输出目录（默认 `./benchmark-runs/<时间戳>-swebench/`）：

```text
<output>/
├── manifest.json          # 运行清单：本次跑批的实验条件（开跑即写，结束时更新为 completed）
├── predictions.jsonl      # 官方预测格式（空 patch 也保留一行）
├── official/              # harness 日志、exit-code、官方 report；续跑时另有 pending-predictions.jsonl
├── report.json            # 聚合报告（内嵌 manifest）
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
- 若 Docker Desktop 配置的镜像加速器返回 `this image is not in the allowlist`，可用允许任意 Docker Hub 路径的镜像站拉取后改回官方名，例如：
  `docker pull --platform linux/amd64 docker.1ms.run/swebench/<image>:latest && docker tag docker.1ms.run/swebench/<image>:latest swebench/<image>:latest`。
- 预拉耗时与镜像层大小相关（实测 4.16GB / 约 3 分 20 秒）；amd64 模拟下单个 astropy 题约 7 分钟，容器内存峰值约 235MB（Docker VM 8GB 足够）。
- 评测机器是 x86_64 Linux 时不需要这一步。

### patch-only 基线

M5 的 agent 只改工作树：不安装 repo 依赖、不执行 repo 测试、不 commit。提示词额外要求「不要装依赖/不要跑测试」。因此通过率是 patch-only 基线，不是带测试反馈的完整 agent；`report.md` 会显式标注。空 patch 会写成空串，由官方 harness 记为 unresolved，不会伪造通过。

### 全量跑批（Lite 300）

300 题不要一次跑完：按 12 题一波切成 25 波，每波独立 `--output`，中断只损失当波。2026-11-08 的一次全量跑批记录见 `docs/benchmark-reports/2026-11-08-swebench-lite300.md`。

- 仓库缓存：先用 `git clone --filter=blob:none --no-checkout` 预建持久缓存，每波把 `<output>/cache` 软链过去；直接跑会反复全量克隆，大仓库容易 EOF。
- Python 隔离：只把 venv 的 `python3` 包一层放进 PATH 给 harness 用，避免 agent 在 venv 里执行 `pip install` 污染评测环境。
- 镜像清理：单题镜像约 4GB，每波预拉后 `docker rmi` + `docker system prune -f`；磁盘低于 20G 必须先清理。

### 分片、续跑与合并

以前这三件事靠跑批机器上的 `run-lite300.sh` / `merge-partial.py`，脚本不在仓库里，结果无法复现。现在都在仓库内：

```bash
# 先预检：缺 docker / swebench / 题目文件时立刻失败，而不是跑完 300 题才报错
pnpm bench doctor --instances-file instances.jsonl --eval-mode local

# 拆成 3 片并行跑（每片自己的 --output）
pnpm bench swebench --instances-file instances.jsonl --shard 1/3 --output runs/s1 &
pnpm bench swebench --instances-file instances.jsonl --shard 2/3 --output runs/s2 &
pnpm bench swebench --instances-file instances.jsonl --shard 3/3 --output runs/s3 &
wait

# 中断后接着跑：跳过已完成的题，且只评测本次新跑的部分
pnpm bench swebench --instances-file instances.jsonl --shard 2/3 --output runs/s2 --resume

# 合成一轮（校验可比性 → 合并 → 重算指标）
pnpm bench merge runs/s1 runs/s2 runs/s3 --output runs/merged
```

三条约束写在代码里，不是约定：

- **分片确定性**：`--shard i/n` 按 `idx % n === i` 交错取片，同一份 selection 与同一组参数永远得到同一子集；所有分片拼起来恰好覆盖全集（`test/shard.test.ts` 钉住）。
- **合并只认同一个父集合**：每片 manifest 记 `parentIdsHash`/`parentCount`，条件不同（模型、commit、题目集）或同一题出现在两片里，merge 直接拒绝并打印 diff——重叠题会让 passRate 被重复计数。
- **续跑不重评测**：复用的题带着上次的官方 verdict 一起进报告；只把新跑的题送 harness（`official/pending-predictions.jsonl`）。`--resume` 的清单条件与上次不一致时也直接拒绝。

`bench doctor` 检查项：模型三档配置（含 `$ENV` 引用是否已设置）、git commit/dirty、题目文件与重复 id、输出目录可写、磁盘余量、`python3 -m swebench`、docker daemon、HF 镜像可达、远端模式的 ssh/tmux、遥测 endpoint。任何 fail 都会给出可执行的修复命令，并让进程以非 0 退出；`--offline` 跳过全部网络探测。

- 配额中断：命中 `exceeded_current_quota_error` 立即停在该波、不推进进度；用单独目录重跑未完成题，再把 `passed` / token / predictions 并回主波目录。
- 汇总：只聚合逐波 `report.json`，并校验 300 行、instance 集合与 `predictions.jsonl` 一致。

**读报告注意**：续跑合并只改写 `report.json` 与 `predictions.jsonl`，逐波 `report.md` 与 `official/` 保留该波首次尝试的快照。通过率、token 与失败原因一律以 `report.json` 为准。

## 自建题（三类）

```bash
pnpm bench custom                # 全部题目
pnpm bench custom --domain finance
```

所有题目都离线、确定性、无网络，校验命令是 workspace 内的 `check.mjs`（退出码 + `expectedStdout`）。题目格式与沉淀流程见 `docs/benchmark-authoring.md`。

## 报告

`report.json` / `report.md` 只包含：suite、dataset/split、instance id、pass/fail、input/output token、时长、脱敏后的失败原因。不写 prompt、回复、patch 或文件内容；失败原因经 `sanitizeErrorMessage` 去除路径/URL/邮箱后再截断。

有官方 report 时，pass/fail 以官方 `resolved` 列表为准；runner 自己的结果只用于对照与失败原因。

指标口径：

- 每个指标同时给 `mean` / `median` / `p90`。均值会被单题的长上下文拉偏（Lite300 里 `django-13710` 一题 2445 万 input token，把 300 题均值抬高约 20%），成本结论以中位数与 p90 为准。
- `tokens.byTier` 按模型档位切开（main 与 worker/task 用不同档位），并给 `tierCoverage`（带分档位数据的题数占比）；覆盖率小于 1 时 `byTier` 只是下界。
- `tokensPerResolved` 是每个通过题的平均 token 消耗；没有通过题时为 `null`，不伪装成 0。
- `patchOnly` 由运行档（`src/runtime-profile.ts`）推导，不再恒为 true。

## 可比较性

`manifest.json` 是「两次跑批能不能放在一起比」的唯一依据，`report.json` 内嵌同一份清单。它记录：git commit 与 dirty、agent 包版本、node/platform、三档模型的 `provider/model/baseUrlHost/baseUrlPath`（不含 apiKey，也不含 baseUrl 查询串）、运行档（特性开关、并行数、审批、超时、patch-only）、题目集哈希（`idsHash` 与实际选中集合，`tasksetHash` 为自建题内容）、评测方式。

判定规则（`describeManifestDiff`）：suite、运行档、任一模指纹、主 agent 档位、git commit、包版本、`idsHash`、`tasksetHash`、dataset/split、评测模式任一项不同，即视为不可比。因此：

- 换模型、改 prompt、改开关都会体现在清单里，不需要在报告文档里手写「本次与上次不可对比」。
- `status: "running"` 表示跑批没走完（进程被杀或抛错），此时目录里的结果不能用于结论。
- 跑批中途注意：清单在开跑时先落一份 `running`，结束时改写为 `completed` 并补 `finishedAt` / `durationMs`。

## 遥测

跑批结束后按 **每批 200 条** 上报 `benchmark_run`（`kind=benchmark`，独立安装 ID）。不是每题一次请求：服务端 `/ingest` 是 60 req/min 的滑动窗口限流，300 题逐条连发实测会丢掉约 10%，且客户端静默。

每条事件除结果（`passed`、`durationMs`、`inputTokens`、`outputTokens`）外，还带本轮的可比较条件：

| 字段 | 含义 |
|---|---|
| `runId` | 聚合键；服务端据此把 N 条事件合成「一轮」 |
| `commit` / `commitDirty` | 对应 `manifest.agent.git`；脏工作区的结论不对应任何提交 |
| `model` / `tier` | `provider/model` 与主 agent 档位 |
| `patchOnly` | 是否 patch-only 基线 |
| `tasksetHash` | 题目集内容哈希（自建题） |
| `errorClass` | 失败分类枚举；通过题不传 |
| `byTier` | 按档位的 token（只发非零档位） |

投递结果写回 `report.json` 的 `telemetry` 字段（`enabled`/`events`/`sent`/`failed`/`batches`/`dropped`），`report.md` 的 Run 段会显示 `7/300 events delivered` 这类行——**丢了多少条必须可查**。遥测关闭、endpoint 为空或网络失败都不影响跑批与报告，也不会抛错。

## 测试

全部测试 hermetic：脚本化适配器、临时 git 仓库、临时 HOME，不触网、不跑 Docker/SSH。真实跑批是手动操作，不进入 `pnpm test`。

```bash
pnpm test
pnpm typecheck
pnpm exec biome check .
```
