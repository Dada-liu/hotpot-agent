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
# 1. 激活 venv 并导出实例
source ~/swebench-venv/bin/activate
python packages/benchmarks/scripts/export_instances.py \
  --dataset SWE-bench/SWE-bench_Lite --split test --limit 10 \
  --output instances.jsonl

# 2. 生成 patch 并调用官方评测（默认 max_workers=1）
pnpm bench swebench \
  --instances-file instances.jsonl \
  --limit 10 \
  --eval-mode local \
  --max-workers 1
```

默认数据集 `SWE-bench/SWE-bench_Lite`、split `test`、seed 0；`--instance-ids a,b` 可指定题目。也可 `--eval-mode remote --eval-host <主机>` 把 Docker 评测调度到远程机器。

输出目录（默认 `./benchmark-runs/<时间戳>-swebench/`）：

```text
<output>/
├── predictions.jsonl      # 官方预测格式（空 patch 也保留一行）
├── official/              # harness 日志与官方 report
├── report.json            # 聚合报告
├── report.md              # 人读报告
├── cache/                 # 仓库缓存
└── workspaces/            # 每题 worktree，跑完即清理
```

### Apple Silicon 注意

`swebench` 5.x 拉镜像不传 platform，需要先手动预拉 amd64 镜像（镜像名可用 harness 的 `make_test_spec` 计算），否则报 `no matching manifest for linux/arm64/v8`。详见 `packages/benchmarks/README.md`。

## 自建三题

```bash
pnpm bench custom                # 三题全跑
pnpm bench custom --domain finance   # 只跑金融题
```

三题（金融 / 软件开发 / 自媒体）全部离线、确定性、无网络，校验命令是 workspace 内的 `check.mjs`。题目格式与沉淀流程见 `docs/benchmark-authoring.md`。

## 怎么读报告

`report.json` / `report.md` 只包含：suite、dataset/split、instance id、pass/fail、input/output token、时长、脱敏后的失败原因——**不写 prompt、回复、patch 或文件内容**。有官方 report 时，pass/fail 以官方 `resolved` 列表为准。

注意通过率是 **patch-only 基线**：agent 只改工作树，不装 repo 依赖、不跑 repo 测试，不是带测试反馈的完整 agent。

参考数据：2026-10-19 Lite 10 题跑批，9/10 resolved，平均单题 input 908,943 / output 17,615 token、耗时 185s，估算成本约 $4.62（非高峰价）。详见 [Benchmarks](/advanced/benchmarks)。
