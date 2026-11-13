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
| `../../benchmark-runs/experiments/<slug>/{base,head}` | 两轮跑批产物，已 gitignore |

跑批产物刻意不放在 worktree 里：`pnpm exp close` 会删掉 worktree，产物必须能活下来。

## 闭环

| 步骤 | 命令 | 产物 | 拦得住什么 |
|---|---|---|---|
| 1. 立假设 | `pnpm exp new <slug> --hypothesis "..."` | 两个 worktree + 台账记录 | 没有假设、slug 重复、分支已存在、目录残留 |
| 2. 跑两轮 | 命令由 `new` 打印，两处共用同一份实例文件与 `--repeat` | `manifest.json` + `report.json` ×2 | 忘记装依赖、两边题集不同、重复次数不同 |
| 3. 登记 | `pnpm exp record <slug> --variant base\|head` | `runs[]`，两轮齐了自动算对比 | 跑批没走完、工作区脏、base 提交漂移、条件不一致 |
| 4. 看结论 | `pnpm exp show <slug>` / `pnpm exp list` | 逐题翻转与判定阈值 | —— |
| 5. 决策 | `pnpm exp decide <slug> --verdict ... --note "..."`，之后 `pnpm exp close <slug>` | `decision`，状态转 `decided`/`closed` | 决策没有理由；结论与决策矛盾时警告 |

第 5 步之后仍有一条尾巴：**上线后按记录里的回滚条件观察**。台账提供的是「当时凭什么判」，线上数据回归验证目前靠人工，尚未接自动化。

## 记录里的字段

| 字段 | 谁写 | 为什么要 |
|---|---|---|
| `baseRef` / `baseCommit` | `new` | 基线锁在具体 sha 上，`ref` 只是给人看的 |
| `branch` / `worktree` / `baseWorktree` | `new` | 从记录能直接定位代码 |
| `suite` / `repeat` / `modelTier` | `new` | 属于实验条件；`repeat` 参与可比性判定 |
| `instancesFile` | `new` | 两个 worktree 共用一份，避免「版本不同、题目也不同」 |
| `hypothesis` | `new`（必填） | 没有可证伪的假设，跑完也判断不了 |
| `primaryMetric` / `guardrailMetric` / `rollback` | `new`（有默认值） | 决策时要对着它判，不是事后挑指标 |
| `runs[]` | `record` | 每轮跑批的事实：runId、提交、通过率、每轮通过率、成本 |
| `comparison` | `record` | 机械结论：better/worse/inconclusive + 逐题翻转 |
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
| `new` 报目录已存在 | 之前手动删了目录或中断 | `git worktree prune` 后重试 |
| 台账里有记录但没有目录 | 目录被手动删除 | `pnpm exp close` 会把记录置为 `closed`，分支保留 |

残留 worktree 用 `git worktree list` 对齐 `registry.json`：**台账里没有的目录就是孤儿**，其存在说明某次 `new` 中途失败（正常情况下命令会回滚）。

## 与遥测的关系

每轮跑批都会按 `benchmark_run` 上报（`kind=benchmark`），事件带 `runId` / `attempt` / `commit` / `model` / `tier`。遥测服务端按 `(runId, instanceId, attempt)` 落库，因此：

- 台账里的 `runId` 可以直接在遥测后台按轮查；
- 本地 `record` 校验过的实验条件，与远端同一条 `runId` 下的条件同源（都来自 `manifest.json`）。

遥测是旁路：上报失败不影响跑批与台账，但 `report.json.telemetry.dropped > 0` 时要当心远端数据不全。
