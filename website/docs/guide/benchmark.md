# 跑 Benchmark

hotpot-agent 内置 benchmark runner：在真实仓库上跑无交互 agent 生成 patch，调用官方 `swebench` harness 评分，输出通过率与 token 成本报告。

> benchmark 是开发/评测工具，只在源码仓库中提供（`pnpm bench`），不进入发布的 CLI / server 产物。

## 前置条件

- Node >= 22、pnpm
- Python 3.11/3.12 的 venv，安装 `swebench`（SWE-bench 评测用）：

  ```bash
  python -m venv ~/swebench-venv && ~/swebench-venv/bin/pip install swebench
  ```

- Docker（官方 harness 在容器里跑测试）；Apple Silicon 用 Docker Desktop 的 amd64 模拟
- HuggingFace 访问：`export HF_ENDPOINT=https://hf-mirror.com`

模型凭证复用用户级 `~/.hotpot/settings.json` 三档配置；benchmark 的会话写在临时 HOME，不会污染真实会话。

## SWE-bench

```bash
# 1. 激活 venv 并导出实例（一次即可，不需要 --limit：默认套件自己钉住题目清单）
source ~/swebench-venv/bin/activate
python benchmarks/scripts/export_instances.py \
  --dataset SWE-bench/SWE-bench_Lite --split test \
  --output instances.jsonl

# 2. 跑默认套件：lite10 的 10 题，每题重复 3 次
pnpm bench swebench --instances-file instances.jsonl

# 只要一次结果，或换成自己的题集
pnpm bench swebench --instances-file instances.jsonl --repeat 1
pnpm bench swebench --instances-file instances.jsonl --instance-ids a__a-1,b__b-2 --repeat 3
```

不给 `--limit` / `--instance-ids` 时跑 `suites/lite10.json` 里固定的 10 题，而不是随机抽 10 题：`--limit` 依赖实例文件的行序与 seed，换一份导出文件就会换题，两次跑批无法按题配对。

默认数据集 `SWE-bench/SWE-bench_Lite`、split `test`、seed 0；`--instance-ids a,b` 可指定题目。也可 `--eval-mode remote --eval-host <主机>` 把 Docker 评测调度到远程机器。

输出目录（默认 `./benchmark-runs/<时间戳>-swebench/`）：

```text
<output>/
├── predictions-a1.jsonl   # 第 n 次尝试的官方预测（空 patch 也保留一行）
├── official/attempt-1/    # 每次尝试独立评测：harness 日志与官方 report
├── report.json            # 聚合报告（含逐尝试明细）
├── report.md              # 人读报告
├── cache/                 # 仓库缓存
└── workspaces/            # 每题 worktree，跑完即清理
```

### 为什么要重复跑

同一份代码、同一个模型，单次通过率的波动很大：Lite 300 的 25 个波次里，单波通过数从 1/12 到 10/12。只跑一次，`+2pp` 和噪声无法区分。

`--repeat 3` 让报告给出每轮各自的通过率、极差与 flaky 题数。判定标准是「差异是否超过同一版本自己的极差」，而不是看两个点估计谁高。10 题 ×3 约 20 元，代价可控；代价是只能分辨 10pp 量级的变化，更小的效应需要更大的题集与更多次数。

### Apple Silicon 注意

`swebench` 5.x 拉镜像不传 platform，需要先手动预拉 amd64 镜像（镜像名可用 harness 的 `make_test_spec` 计算），否则报 `no matching manifest for linux/arm64/v8`。详见 `benchmarks/README.md`。

## 自建题（三类）

```bash
pnpm bench custom                    # 全部题目
pnpm bench custom --domain finance   # 只跑金融域
```

所有题目（金融 / 软件开发 / 自媒体三类）全部离线、确定性、无网络，校验命令是 workspace 内的 `check.mjs`。题目格式与沉淀流程见 `docs/benchmark-authoring.md`。

## 怎么读报告

`report.json` / `report.md` 只包含：suite、dataset/split、instance id、pass/fail、input/output token、时长、脱敏后的失败原因——**不写 prompt、回复、patch 或文件内容**。有官方 report 时，pass/fail 以官方 `resolved` 列表为准。

注意通过率是 **patch-only 基线**：agent 只改工作树，不装 repo 依赖、不跑 repo 测试，不是带测试反馈的完整 agent。

参考数据：2026-10-30 ~ 11-08 的 SWE-bench Lite 全量 300 题跑批（Kimi 档位，patch-only），168/300 resolved（56.0%），平均单题 input 393,787 / output 9,888 token、耗时 323s；另有一次 2026-10-19 的 Lite 10 题基线（DeepSeek 档位）9/10。两次模型档位不同，不能直接对比。详见 [Benchmarks](/advanced/benchmarks) 与仓库 `docs/benchmark-reports/2026-11-08-swebench-lite300.md`。
