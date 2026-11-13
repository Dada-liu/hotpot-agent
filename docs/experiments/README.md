# docs/experiments/

实验台账。一条记录 = 一个「功能需求 → 一对 worktree → 两轮跑批 → 人的决策」的闭环。

## 为什么需要它

在这之前，实验的痕迹只有三样：`.worktrees/` 下的目录、某个分支上的提交、某次跑批的 `report.json`。三者之间没有任何标识把它们串起来，结果是：

- `.worktrees/` 里堆了 6 个目录，没人说得清每个在验证什么；
- 「新版比旧版好」只能靠两个人在两个终端各看一个百分数；
- 过一个星期，找不到「这次的基线是哪一轮跑出来的」。

台账把「实验条件」和「跑批结果」放进同一条记录，并且由命令负责校验：条件不一致的两次跑批不允许放在一起比。

## 目录里有什么

| 路径 | 说明 |
|---|---|
| `registry.json` | 唯一事实源。由 `pnpm exp` 读写，手改会被下一次写入覆盖 |
| `<slug>.md` | 由记录渲染的人读视图。**不要手改**，改内容请用命令 |
| `../.worktrees/<slug>` | 候选代码（分支 `exp/<slug>`），已 gitignore |
| `../.worktrees/<slug>-base` | 基线代码，detached 在 `baseCommit`，已 gitignore |
| `../../benchmark-runs/experiments/<slug>/{base,head}` | 两轮跑批产物（含 `exp-run.log` 子进程日志），已 gitignore |
| `../../benchmark-runs/experiments/<slug>/telemetry.json` | 远端回读的完整对账明细（`exp pull` 生成），已 gitignore |

跑批产物刻意不放在 worktree 里：`pnpm exp close` 会删掉 worktree，产物必须能活下来。

## 闭环

| 步骤 | 命令 | 产物 | 拦得住什么 |
|---|---|---|---|
| 1. 立假设 | `pnpm exp new <slug> --hypothesis "..."` | 两个 worktree + 台账记录 | 没有假设、slug 重复、分支已存在、目录残留 |
| 2. 跑两轮 | `pnpm exp run <slug>` | `manifest.json` + `report.json` ×2、`exp-run.log` ×2 | 实例文件缺失、worktree 脏、基线漂移、重复次数不同、产物与提交对不上 |
| 3. 登记 | `run` 自动完成（等价手工命令 `pnpm exp record <slug> --variant base\|head`） | `runs[]`，两轮齐了自动算对比 | 跑批没走完、工作区脏、base 提交漂移、条件不一致 |
| 4. 回读遥测 | `pnpm exp pull <slug>` | `telemetry.json` + 台账 `telemetry` 摘要 | 远端缺轮、上报丢事件导致口径不一致 |
| 5. 看结论 | `pnpm exp show <slug>` / `pnpm exp list` | 逐题翻转、判定阈值、远端对账 | —— |
| 6. 决策 | `pnpm exp decide <slug> --verdict ... --note "..."`，之后 `pnpm exp close <slug>` | `decision`，状态转 `decided`/`closed` | 决策没有理由；结论与决策矛盾时警告 |

`run` 是第 2、3 步的合体：默认按 base → head 顺序执行，任一变体失败立即停止且**不登记任何东西**；中断后重跑同一条命令会跳过已完成变体、带 `--resume` 续跑未完成的。`--pull` 可以把第 4 步也串进去。

第 6 步之后仍有一条尾巴：**上线后按记录里的回滚条件观察**。台账提供的是「当时凭什么判」，线上数据回归验证目前靠人工，尚未接自动化。

## 记录里的字段

| 字段 | 谁写 | 为什么要 |
|---|---|---|
| `baseRef` / `baseCommit` | `new` | 基线锁在具体 sha 上，`ref` 只是给人看的 |
| `branch` / `worktree` / `baseWorktree` | `new` | 从记录能直接定位代码 |
| `suite` / `repeat` / `modelTier` | `new` | 属于实验条件；`repeat` 参与可比性判定 |
| `instancesFile` | `new` | 两个 worktree 共用一份，避免「版本不同、题目也不同」 |
| `hypothesis` | `new`（必填） | 没有可证伪的假设，跑完也判断不了 |
| `primaryMetric` / `guardrailMetric` / `rollback` | `new`（有默认值） | 决策时要对着它判，不是事后挑指标 |
| `runs[]` | `record` / `run` | 每轮跑批的事实：runId、提交、通过率、每轮通过率、成本 |
| `comparison` | `record` / `run` | 机械结论：better/worse/inconclusive + 逐题翻转 |
| `telemetry` | `pull` | 远端回读摘要：拉取时间、窗口、每轮对账状态与差异；重跑后自动清空 |
| `decision` | `decide` | 人的结论 + 理由 + 当时的对比快照 |

`comparison` 与 `decision` 分开存，是因为两者可能不一致：人可以在数据 inconclusive 时凭代码评审上线，也可以在数据 better 时因成本否决。不一致本身不违反纪律，**不留痕**才违反。

## 判定口径与它的边界

登记完两轮后自动算：

```
阈值 = max(base 自身极差, head 自身极差, 100 / 题数)
|head.passRate - base.passRate| > 阈值  =>  better / worse
否则                                  =>  inconclusive
```

- `100 / 题数` 是单题刻度：10 题套件上多对 1 题就是 10pp，不该被当作改进。
- `attempts < 2` 一律 `inconclusive`：没有「同一版本自己跑 k 次」的波动幅度，任何差异都无法与噪声区分。
- **这不是显著性检验。** 配对 McNemar 与成本 bootstrap 区间在 `docs/eval-system-plan.md` 里是 P3-2，尚未实现。所以它只能排除明显变差，不能证明小幅改进；`+2pp` 量级需要几百题 × 多次，本阶段不做。

## 常见故障与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `record` 报「基线已经漂移」 | 在 main 里跑了 base，而 main 已经前进 | 在 `.worktrees/<slug>-base` 里重跑；那个 worktree 是 detached 的，不会漂 |
| `record` 报「跑完之后又改过代码」 | head 跑批后 worktree 又提交/改动 | 重跑 head，或把跑批后的提交记成新实验 |
| `show` 显示 base 不在 head 历史里 | 分支被 rebase | 差异里混进了别人的提交，重新基于 `baseCommit` 建分支 |
| `close` 拒绝回收 | worktree 有未提交改动 | 先提交到 `exp/<slug>`，确认无用再加 `--force` |
| `run` 报「实例文件不存在」 | 没导出实例，或导出文件被删 | 按提示导出一份 Lite 实例文件，两个 worktree 共用 |
| `run` 报「基线漂移」 | 基线 worktree 被 checkout 到了别的提交 | 新开实验；基线 worktree 是 detached，正常情况下不会漂 |
| `run` 中途失败 | harness / 配额 / 网络 | 看 `<runDir>/exp-run.log`；修好后重跑同一条命令，会自动复用与续跑，且不会留下半套登记 |
| `pull` 报 `missing` | 遥测被关闭、事件投递失败，或查询窗口没覆盖跑批时间 | 查 `report.json.telemetry.dropped`；用 `--from/--to` 手动指定窗口 |
| `pull` 报 `mismatch` | 远端丢事件 / 服务端版本旧 | 先别用远端数字做决策；核对服务端 schema 版本与逐题明细 |
| `pull` 报缺凭据 | 未设置 `HOTPOT_TELEMETRY_ADMIN_PASSWORD` | 用环境变量注入，不要写进仓库或命令行历史 |
| `new` 报目录已存在 | 之前手动删了目录或中断 | `git worktree prune` 后重试 |
| 台账里有记录但没有目录 | 目录被手动删除 | `pnpm exp close` 会把记录置为 `closed`，分支保留 |

残留 worktree 用 `git worktree list` 对齐 `registry.json`：**台账里没有的目录就是孤儿**，其存在说明某次 `new` 中途失败（正常情况下命令会回滚）。

## 与遥测的关系

每轮跑批都会按 `benchmark_run` 上报（`kind=benchmark`），事件带 `runId` / `attempt` / `commit` / `model` / `tier`。遥测服务端按 `(runId, instanceId, attempt)` 落库，因此：

- 台账里的 `runId` 可以直接在遥测后台按轮查；
- 本地 `record` 校验过的实验条件，与远端同一条 `runId` 下的条件同源（都来自 `manifest.json`）。

遥测是旁路：上报失败不影响跑批与台账，但 `report.json.telemetry.dropped > 0` 时要当心远端数据不全。

### 回读与对账

`pnpm exp pull <slug>` 用台账里的 runId 去服务端把同一轮数据拉回来，与本地 `report.json` 比对题数、尝试数、通过次数、通过率、`resolvedInstances`、flaky 题数与逐题 flaky 集合。三态结论：

- `ok`：逐项一致，远端数据可以作为决策依据；
- `missing`：窗口内查不到该 runId（遥测关闭 / 事件落在窗口外 / 上报失败）；
- `mismatch`：有差异，退出码 1，差异逐条打印并写进台账——此时远端数字不能当决策依据。

服务端所有读接口都在 admin 会话下（没有独立只读 token），所以 `pull` 通过 `POST /api/v1/login` 换 `hp_admin` cookie。密码只从 `HOTPOT_TELEMETRY_ADMIN_PASSWORD`（或 `--password-env` 指定的变量）读取，只存在进程内存里；cookie 不落盘，也不写进任何产物。查询窗口默认覆盖登记时间前 2 天到当前之后 1 天，可用 `--from/--to` 覆盖。

**边界**：这里回读的是 `kind=benchmark` 跑批事件，用来验证「远端与本地说的是同一件事」。线上 `kind=user` 遥测目前没有 commit / experimentId，无法归因到具体实验，上线后的回归验证仍需人工（见 `docs/eval-system-plan.md` 的 P2 缺口）。
