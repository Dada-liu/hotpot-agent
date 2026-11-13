# Benchmarks

`@hotpot/benchmarks` 是 M5 的评测工具：在真实仓库上跑无交互 agent 生成 patch，调用**官方 `swebench` harness** 评分，输出通过率与 token 成本报告；另有三个离线种子任务覆盖金融、软件开发、自媒体。

评分不自己实现——pass/fail 全部以官方 harness 的 `resolved` 列表为准。

## 运行器设计

| 模块 | 职责 |
|------|------|
| `agent-runner` | 无交互跑一个 task turn：临时 HOME、allow-all 审批（落盘审计）、plan 自动批准、超时 abort、整棵树 token 汇总 |
| `swebench/workspace` | 仓库缓存 + 每题独立 git worktree；`capturePatch` 生成 diff（含 untracked，排除 node_modules / .hotpot） |
| `swebench/instances` | 实例 JSONL 解析与确定性选择（limit / instance ids / seed 固定可复现） |
| `suites` | 默认套件 `lite10.json`：固定的 10 个 instance id，不依赖 `--limit` 的洗牌结果 |
| `swebench/evaluate` | 官方 harness 编排：local 直接执行，remote 经 rsync + tmux（无 tmux 回退 nohup） |
| `custom/runner` | 自建题：临时 workspace + `check.mjs` 校验命令（退出码 + `expectedStdout`） |
| `report` | `report.json` / `report.md`：通过率、逐尝试波动、每题汇总、均值/中位数/p90、脱敏失败列表 |
| `telemetry-read` | 遥测只读客户端：admin 登录换 cookie，按 `runId` 拉跑批列表与逐题明细 |
| `experiment/` | `pnpm exp` 实验台账：`new` 建一对 worktree → `run` 跑两轮并登记 → `pull` 回读遥测对账 → `decide` 留痕 |

用法（前置条件与命令细节见[跑 Benchmark](/guide/benchmark)）：

```bash
pnpm bench swebench --instances-file instances.jsonl            # lite10 × 3 次
pnpm bench swebench --instances-file instances.jsonl --repeat 1 # 单次
pnpm bench swebench --instances-file instances.jsonl --suite lite10  # 显式指定套件
pnpm bench custom
```

验证一个功能改动时不必手工拼两次跑批：`pnpm exp new <slug> --hypothesis "..."` 建一对隔离的 worktree 与台账，`pnpm exp run <slug>` 顺序跑完两轮并自动登记，`pnpm exp pull <slug>` 把远端遥测拉回来与本地报告对账。细节见仓库 `docs/experiments/README.md`。

## 默认套件与重复尝试

不给 `--limit` / `--instance-ids` 时跑 `suites/lite10.json` 的 10 题，每题默认重复 3 次。两件事都是为了「可比较」：

- 套件用 id 清单而不是 `--limit 10`。`limit` 在实例文件的行序上洗牌再截取，换一份导出文件就会换题，前后两次无法按题配对。
- 重复次数写进 `manifest.repeat`，与模型、commit 一起构成可比性条件。报告给出每轮通过率（`repeat.passRateByAttempt`）、极差、样本标准差与 flaky 题数；`passRate` 是尝试级平均，`resolvedInstances` 是「至少通过一次」的题数，两者分开，避免用后者掩盖稳定性下降。

判定一个改动是否有效：差异要超过同一版本自己跑 k 次的极差，否则只能记 `inconclusive`。

## patch-only 基线

M5 的 agent 只改工作树：不安装 repo 依赖、不执行 repo 测试、不 commit，提示词额外要求「不要装依赖/不要跑测试」。因此通过率是 patch-only 基线，不是带测试反馈的完整 agent；空 patch 写成空串由官方 harness 记为 unresolved，不伪造通过。`report.md` 会显式标注这一点。

## 实测数据

两次正式跑批的模型档位不同，通过率不能直接对比。

### SWE-bench Lite 300（2026-10-30 ~ 11-08）

全量 300 题，high 档 `k3`、medium/low 档 `kimi-for-coding`（Kimi 订阅入口），patch-only：

| 指标 | 数值 |
|------|------|
| 通过率 | **168/300 resolved（56.0%）** |
| 平均单题 input token | 393,787（合计约 1.18 亿） |
| 平均单题 output token | 9,888 |
| 平均单题耗时 | 323s（约 5.4 分钟） |

分仓库通过率：

| 仓库 | 通过 | 仓库 | 通过 |
|------|------|------|------|
| django | 75/114 | sphinx-doc | 10/16 |
| sympy | 40/77 | astropy | 4/6 |
| scikit-learn | 15/23 | pylint-dev | 3/6 |
| matplotlib | 11/23 | psf | 0/6 |
| pytest-dev | 8/17 | pydata | 0/5 |
| mwaskom | 2/4 | pallets | 0/3 |

132 题失败的原因分布（以逐波 `report.json` 为准）：

| 失败原因 | 题数 | 含义 |
|----------|------|------|
| `unresolved by official harness` | 59 | patch 已生成但官方测试未通过 |
| `turn aborted` | 43 | agent 回合中断（超时或会话中断） |
| `max_tokens` | 26 | 回合被输出上限截断 |
| `empty patch` / 请求失败 / 进程终止 | 4 | 未产生 patch 或链路异常 |

`turn aborted` 与 `max_tokens` 合计 69 题，属 agent / 配置侧中断，不代表 patch 内容一定错误。
逐波通过数在 1/12 ~ 10/12 之间波动（wave 13 最低，wave 04、07 最高），低波次的失败以官方 unresolved 为主，
不能全部归因于配额中断或超时；解读 56.0% 时应结合这一波动。逐题明细与跑批条件见仓库
`docs/benchmark-reports/2026-11-08-swebench-lite300.md`。

### SWE-bench Lite 10（2026-10-19，基线）

2026-10-19 跑批（macmini，DeepSeek 档位，非高峰价估算）：

| 指标 | 数值 |
|------|------|
| 通过率 | **9/10 resolved（90%）** |
| 平均单题 input token | 908,943 |
| 平均单题 output token | 17,615 |
| 平均单题耗时（agent 阶段） | 185.2s |
| 10 题估算成本 | **约 $4.62**（高峰约 $9.25） |

失败 1 题为 `pylint-dev__pylint-7228`（patch 成功应用，两个 FAIL_TO_PASS 用例失败）。模型训练语料可能覆盖公开 benchmark 题目，解读通过率时需注意。

## 题目沉淀

自建题遵循「筛选历史会话 → 脱敏 → 题目化 → 校验脚本 → 回归」的流程（`docs/benchmark-authoring.md`），三个领域（金融 / 软件开发 / 自媒体）先各 1 题打底，后续从使用历史持续沉淀。

## 遥测

跑批结束后按 200 条一批上报 `benchmark_run`（`kind=benchmark`，独立安装 ID），每条带 `runId`、`commit`、`model`、`tier`、`patchOnly` 等可比较条件，服务端据此把 N 条事件折成「一轮」。`--repeat k` 时事件数是题数 × k，聚合后得到的是尝试级通过率。遥测关闭或网络失败不影响跑批与报告，投递结果写回 `report.json` 的 `telemetry` 字段。
