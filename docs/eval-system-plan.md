# Agent 评估体系完善计划

> 目标：把当前"能跑分的 benchmark"升级为"能支撑功能优化的评测基础设施"。
> 判定标准只有一条：拿到一个改动（prompt、编排、工具、上下文策略），这套体系能否在一个可接受的成本内给出**可比较、可归因、可置信**的结论。
> 现状基线：`benchmarks/`（swebench + custom 两套）、`docs/benchmark-authoring.md`、`docs/benchmark-reports/2026-11-08-swebench-lite300.md`。

## 1. 现状盘点

### 1.1 已经具备的

| 能力 | 位置 | 说明 |
|---|---|---|
| 官方评分 | `benchmarks/src/swebench/evaluate.ts` | 不自己造评分，pass/fail 以官方 `resolved` 为准 |
| 轨迹事实源 | `packages/core/src/session/events.ts` | 每个 step 的 usage/model/tier、tool_call、tool_result、agent_spawn、approval、error 全部落盘 |
| 隔离跑批 | `benchmarks/src/agent-runner.ts` | 临时 HOME、每题独立 worktree、allow-all 审批、超时 abort |
| 离线题校验 | `benchmarks/src/custom/task.ts` + `custom/runner.ts` | 确定性、无网络、退出码 + stdout 子串 |
| 题目沉淀流程 | `docs/benchmark-authoring.md` | 含反例清单，避免收不可校验的题 |
| 报告脱敏 | `benchmarks/src/report.ts` | 不写 prompt/回复/patch，失败原因经 `sanitizeErrorMessage` |

### 1.2 阻碍它成为"优化基础设施"的缺口

按严重程度排序，每条都给证据。

**G1 报告不可比较。** `report.json` 只有 suite/dataset/split/pass/token/duration，没有模型名、模型档位、git commit、特性开关、超时、并发、题目集哈希。于是 Lite10 与 Lite300 只能靠文档里手写"模型档位不同、不能对比"。一次改动的效果无法和上一次对齐。

**G2 没有失败分类，只有一句自由文本。** `report.ts` 把失败压成 `error` 字符串（截断 300 字符）。Lite300 的 132 题失败里，"官方 unresolved 59 / turn aborted 43 / max_tokens 26 / empty patch 2 / 基础设施 3"这张表是人工读 report.json 数出来的。优化排期需要的正是这张表，但它现在不可机器聚合。

**G3 只测结果，不测过程。** 报告没有 step 数、工具调用数与错误率、上下文峰值、重复调用、agent 树规模、plan 修订次数。而实际失败大头（aborted 43、max_tokens 26）恰恰是循环控制问题——对应 `docs/improvement-report-2026-10-26.md` 的 P1-7（无上下文管理、无 step 上限）与 P1-8（无重试）。`agent-runner.ts` 返回了 `sessionFilePath`，`cli.ts` 直接丢弃；custom 套件连 tokens 之外的信息都不返回，轨迹全丢。

**G4 单次跑批无统计意义。** 每仓 n=1。证据：同一代码同一模型的 25 个波次，通过数从 1/12 到 10/12；Lite10 与 Lite300 重叠 10 题有 4 题翻转。在这种方差下，+2pp 的改动和噪声不可区分，用它做门禁会误判。没有 `--repeat`，没有配对检验，没有置信区间。

**G5 测的东西和项目差异化不匹配。** `agent-runner.ts` 固定：`maxParallelTasks: 1`、`plan` 自动批准、`features` 全关（todo/hooks/skills/promptTemplates/web/mcp）、审批 allow-all。也就是说三层编排、并行拆分、plan 审批、权限、steer、skill 加载——这些"要优化的功能"在评测里覆盖率为 0。评测只测了单 agent 直通的 patch 质量。

**G6 跑批慢且不可复现。** `cli.ts` 的实例循环是串行的（`for` + `await`），300 题跑了 25 波、9 天；分波/续跑/合并依赖跑批机器上的 `run-lite300.sh`、`merge-partial.py`，不在仓库里。仓库内没有 `--shard`、`--resume`、`merge`。

**G7 只有均值，且均值被离群值带偏。** `report.ts` 只算 `average`。Lite300 平均 input 393,787 token，其中 `django-13710` 单题 24,458,475，单题贡献均值 81,528（20.7%）；剔除后其余 299 题均值约 313,303。用均值做成本门禁会被一题拖偏。

**G8 产物不保留，无法事后归因。** 跑完 `cleanup()` 删 worktree、custom 删 workspace，失败题无法复盘"它到底在哪一步走偏"，只能重跑。

**G9 没有 CI 门禁。** `.github/workflows/` 只有 publish 与 website；bench 从未进 CI。改动是否回退只能靠人记得跑。

**G10 评测自身缺校验。** 4 道自建题，负例只覆盖金融与软件两域；没有"金标产物必须通过、空产物必须失败、近似产物必须失败"的强制用例；`check.mjs` 可能写出"grep 期望字符串"这种可被轻易满足的校验。

## 2. 目标结构

五层，自下而上，下层不成立时上层结论无效。

```
L4 判定   compare / repeat / gate / baselines        ← 一次改动是否可合并
L3 覆盖   smoke / dev / full / holdout + capability  ← 改动会影响到哪些题
L2 诊断   failureClass + TraceSummary + 失败看板      ← 为什么失败，改哪里
L1 结果   pass / cost 分布 / 分角色归因                ← 发生了什么
L0 复现   RunManifest + shard/resume/merge + doctor   ← 这次跑的是什么
```

依赖顺序也是实施顺序：先 L0（否则结果不可比），再 L1/L2（最便宜的有效信号），最后 L3/L4（覆盖与门禁）。反过来做，会拿不可信的数字做门禁。

## 3. 分阶段计划

### P0 可比较（L0 + L1，无 agent 改动）

| 任务 | 落点 | 验收 |
|---|---|---|
| P0-1 RunManifest | 新增 `benchmarks/src/manifest.ts`；`cli.ts` 每次运行写 `manifest.json`；`report.ts` 内嵌 | 两次跑批除时间戳外 manifest 相同即判定"可比较"；模型/commit/开关任一变化必须体现在 diff 里 |
| P0-2 敏感信息 | manifest 只存 provider/model/baseUrl host，密钥走既有 `sanitizeErrorMessage` 同级策略 | 单测断言 apiKey、绝对路径、URL 查询串不出现 |
| P0-3 分布指标 | `report.ts` 增 `median/p90`、`costPerResolved`、分档位（main/worker/task）与档位级 token | 用 Lite300 的 300 行明细重算，均值口径与文档一致 |
| P0-4 `patchOnly` 去硬编码 | 由 profile 推导，不再恒 `true` | 切换 profile 后字段随之变化 |
| P0-5 `--shard i/n` / `--resume` / `bench merge` | 把外部脚本收进 `cli-args.ts` + 新 `src/shard.ts` | 3 波分片跑完后 merge，instance 集合、pass、token 与单波串行结果一致 |
| P0-6 `bench doctor` | 预检 venv/docker/镜像/磁盘/HF endpoint/模型连通性 | 缺 Docker 时 10 秒内失败并给修复命令，而不是跑 3 小时后 KeyError |

**状态（2026-11-11）：P0-1 ~ P0-6 已全部落地。** 落点与验收对照：

| 任务 | 实际落点 | 验收证据 |
|---|---|---|
| P0-1 | `src/manifest.ts`（含 `describeManifestDiff` / `manifestForComparison`） | `test/manifest.test.ts`；报告头直接显示 commit/模型/运行档/ids sha256 |
| P0-2 | manifest 只存 `baseUrlHost`/`baseUrlPath` | `test/manifest.test.ts` 断言不带 `sk-secret` 与查询串 |
| P0-3 | `report.ts` 的 `mean/median/p90`、`tokens.byTier`、`tierCoverage`、`tokensPerResolved` | `test/report.test.ts`；冒烟里 mean 820 万 vs median 12 万，离群值被显式化 |
| P0-4 | `runtime-profile.ts` 推导 `patchOnly` 与 prompt 后缀 | `test/agent-runner.test.ts`、`test/report.test.ts` |
| P0-5 | `src/shard.ts`、`src/merge.ts`、`cli-args.ts` 的 `--shard/--resume`、`bench merge` | `test/shard.test.ts`（覆盖性）、`test/merge.test.ts`（可比性/重叠/未完成）、`bench merge` 端到端 |
| P0-6 | `src/doctor.ts`（探针可注入）、`bench doctor` | `test/doctor.test.ts` 全注入、141ms 跑完；真机试跑查出 `python3 -m swebench` 缺失并给出修复命令 |

与本文原计划的两处偏差，值得记下来：

- **`--resume` 不只跳过 agent，还跳过重复评测**：复用已完成题的官方 verdict，只把新跑的题送 harness（`official/pending-predictions.jsonl`）。否则省下的 agent 时间会被全量重评测还回去。
- **分片记录父集合哈希**：每片 manifest 带 `parentIdsHash`/`parentCount`，`merge` 先归一成父集合视角再比较，否则三个分片永远互相「不可比」，而外部脚本那套合并恰恰缺少这个判据。

manifest 字段清单：`schemaVersion, runId, startedAt, suite, suiteVersion, tasksetHash, git{commit,dirty}, pkgVersion, node, os/arch, models{tier:{provider,model,baseUrlHost}}, features, knobs{maxParallelTasks,planMaxRevisions,timeoutMs,permissionMode}, selection{dataset,split,seed,limit,count,idsHash}, eval{mode,maxWorkers,harnessVersion,docker}, artifacts{dir,retention}`。

### P1 可诊断（L2）

| 任务 | 落点 | 验收 |
|---|---|---|
| P1-1 TraceSummary | 新增 `benchmarks/src/trace/summary.ts`：从会话 JSONL 折叠出过程指标 | 用真实 Lite300 会话重算，指标与人工抽检 3 题一致 |
| P1-2 失败分类 | 新增 `src/trace/classify.ts`，`failureClass` 枚举 + 规则 | 132 题自动分类与文档人工表一致；不一致的题逐题给理由 |
| P1-3 产物保留 | `--keep-artifacts=failures\|all`，会话 gzip 存 `<output>/sessions/`，体积上限与脱敏 | 默认不留、失败必留；manifest 记录体积与保留策略 |
| P1-4 失败看板 | `bench analysis` 生成 `analysis.md`：failureClass × 诊断标记 × 仓库，附题号与成本 | 输出可直接当优化 backlog 用，不需要再人工点数 |

TraceSummary 字段：`agentCount{main,worker,task}`、`steps`、`assistantMsgs`、`toolCalls{byName}`、`toolErrorRate`、`toolResultBytes`、`maxStepInputTokens`、`contextGrowth[]`、`repeatedCalls`、`internalMsgCount`、`approvalsAsked/Decided`、`planRevisions`、`stopReason`、`filesTouched`、`testsRun`、`perRoleTokens`。

诊断标记（规则命名的，不猜因果）：`context_bloat`（峰值 token 超档位窗口 80%）、`tool_error_loop`（同一 tool+input 重复 ≥3 次）、`error_tool_storm`（工具错误率 >30%）、`premature_stop`（无 write/edit 调用即结束）、`over_editing`（改动文件数 >5 且无测试执行）、`plan_revision_exhausted`。

failureClass 枚举（互斥、可聚合）：`infra_error`、`agent_timeout`、`agent_max_tokens`、`agent_error`、`empty_patch`、`unresolved_localization`、`unresolved_behavior`、`unknown`。规则分类必须标 `classSource: "rule"|"human"`，人工覆盖不回写规则。

### P2 可扩展运行（L0 补完）

| 任务 | 落点 | 验收 |
|---|---|---|
| P2-1 套件分层 | `smoke`（固定 25 题 + 4 自建题）/ `dev`（100 题，按仓库与难度分层）/ `full`（300）/ `holdout`（保留，仅发版） | 各层 manifest 记录分层清单哈希；`holdout` 不得出现在日常跑批 |
| P2-2 防止过拟合 | `benchmarks/suites/dev.json`、`holdout.json` 提交进仓库，seed 固定 | 若有人拿 holdout 调 prompt，compare 能按 manifest 发现并拒绝出结论 |
| P2-3 agent 级并发 | `--agent-concurrency`（worktree 已隔离，只需每实例独立 HOME） | smoke 墙钟从约 2 小时降到 20 分钟量级 |
| P2-4 缓存预热 | 裸仓库缓存复用、镜像预拉清单 | 冷启动失败率显著下降；doctor 检查缓存完整性 |

成本口径（按 Lite300 实测单题约 0.67 元折算）：smoke ≈ 17 元/次，dev ≈ 67 元/次，full ≈ 200 元/次；smoke ×3 重复 ≈ 50 元，够做 nightly。

### P3 可判定（L4）

| 任务 | 落点 | 验收 |
|---|---|---|
| P3-1 重复 | `bench repeat --n k`，保留每次尝试 | 输出 pass@k、单题 flakiness；smoke 要求 k≥3 |
| P3-2 配对比较 | `bench compare base head`：按 instanceId 配对，McNemar 精确检验 + 成本 bootstrap 区间 | 结论三态：`better` / `worse` / `inconclusive`；n<30 或区间跨 0 必须给 `inconclusive` |
| P3-3 门禁 | `bench gate` + `benchmarks/baselines/{smoke,dev}.json` | 规则示例：smoke 通过数下降 >1 题或 p50 成本上涨 >15% 即失败 |
| P3-4 CI | PR 触发 scripted smoke（免费）；live smoke 走 nightly/手动 | PR 上改 prompt/编排时能看到红/绿；live 跑批不进 PR 路径 |

不做的事：不把固定阈值写成常数分布在各处，阈值只放 baseline 文件；不用单次均值做门禁。

**状态（2026-11-12）：P3-1 已落地，P3-2/P3-3/P3-4 未做。** 落地形态与本文不同，两处偏差值得记下：

- 参数是 `--repeat k`（默认 3），与默认套件 `suites/lite10.json` 一起启用：不给 `--limit` / `--instance-ids` 就跑固定 10 题 × 3 次，约 20 元/轮。默认套件用 id 清单而不是 `--limit 10`，因为 limit 依赖实例文件行序与 seed，换一份导出文件就换题。
- **不输出 `pass@k`**。`pass@k` 是「k 次里至少一次通过」，会把稳定性下降完全掩盖（3 次里 1 次 20 题、2 次 12 题 优于 稳定 15 题）。报告给的是尝试级平均通过率、每轮各自通过率、极差、样本标准差与 flaky 题数；`resolvedInstances`（至少通过一次）单独给，只用于说明，不作比较口径。
- 尝试维度贯穿 `predictions-a<k>.jsonl` / `manifest.repeat` / `--resume` / `merge` / `report.perInstance`：官方 harness 按 instance_id 建索引，k 次尝试必须分成 k 个预测文件、k 次独立评测，不能塞进同一个文件。

### P4 覆盖 agent 自身特性（L3，关键缺口）

这一阶段直接对应"评估要能作为优化功能的基础设施"。

| 任务 | 落点 | 验收 |
|---|---|---|
| P4-1 BenchProfile | `agent-runner.ts` 接受 profile，替代写死的 `features:false` / `maxParallelTasks:1` / plan 自动批准 | 至少三档：`baseline`（现状）、`full-features`、`ablation-*` |
| P4-2 scripted 模式 | 假 `LlmAdapter` 回放固定模型输出，断言控制面行为 | 免费、确定性、可进 CI；每个特性至少一条 |
| P4-3 live 模式 | 真实模型跑能力题，测端到端质量 | 与 scripted 共用断言，只是模型来源不同 |
| P4-4 能力场景 | 新增 `benchmarks/src/scenarios/` | 见下表 |
| P4-5 题库 schema v2 | `custom/task.ts` 支持 `prompts[]`（多轮）、`capabilities[]`、`validation.steps[]`、`forbiddenPatterns` | `.strict()` 保持；v1 题继续可加载 |
| P4-6 能力矩阵 | 报告按 capability 汇总 pass/覆盖 | "某特性零覆盖"在报告里可见 |

能力场景最小集：

| capability | 场景 | 断言 |
|---|---|---|
| routing | 6 道不同难度任务 | 档位选择符合难度，且低于全 high 基线成本 |
| plan | 需先规划的任务 | plan 结构合法、修订 ≤ `planMaxRevisions`、审批被记录 |
| parallel | 3 个互不依赖的文件改动 | 产生 ≥2 个 task，墙钟低于串行基线，无写冲突 |
| approval | 危险 bash、只读模式写文件 | 必问 / 必拒，且 `approval/asked`+`decided` 成对落盘 |
| steer | 回合中注入 next-step 消息 | 在 step 边界生效，不打断工具批次 |
| skills | 触发 `SKILL.md` 加载 | 产生 `skill/loaded`，且后续行为引用该 skill |
| resilience | 429 后成功、SSE 停滞、连续 max_tokens、超窗 | 重试有界、超时可控、超窗给出明确错误而非静默截断 |

### P5 评测自身的质量

| 任务 | 验收 |
|---|---|
| 金标产物 | 每题带 `solution/`；测试断言金标通过、空产物失败、2 个近似产物失败 |
| 校验脚本 lint | 禁止联网、禁止读 `prompt`、禁止把答案写进可被直接满足的位置；超时生效 |
| 题目集漂移 | `tasksetHash` 变化时 compare 默认拒绝与旧 baseline 比对，需 `--allow-taskset-change` |
| 覆盖率门槛 | 新增 agent 特性必须同时提交至少一条 scripted 场景，否则评审不通过 |

## 4. 与优化闭环的接口

```
需求 → pnpm exp new（一对 worktree + 台账）
     → pnpm exp run（两轮跑批 + 自动登记，失败即停/中断续跑）
     → pnpm exp pull（回读远端遥测，与本地报告对账）
     → analysis.md（failureClass × 诊断标记 × 成本）
     → 选一个桶（例如 max_tokens 26 题 + context_bloat 命中数）
     → 改一层（core 循环 / prompt / 编排）
     → smoke ×3 看方向，dev ×1 看幅度，compare 出三态结论
     → 过 gate 才能进 baseline
     → pnpm exp decide / close（决策留痕，上线后按回滚条件观察）
```

每个优化 PR 必须写清四件事，缺一不可：假设（哪一层、为什么有效）、指标（主指标 + 护栏指标）、套件（smoke/dev，是否重复）、compare 输出。没有这四项，"变好了"不可证伪。

**状态（2026-11-13）：需求 → 隔离实现 → 双版本跑批 → 拉数据对账 → 决策，这条链上除「跨实验基线」与「门禁」外都能用命令走完。** `pnpm exp new` 建 `exp/<slug>` 与 detached 在 `baseCommit` 的基线 worktree，把需求/假设/指标/套件/回滚条件写进 `docs/experiments/registry.json`（`<slug>.md` 是渲染视图）；`pnpm exp run` 按 base → head 顺序跑两轮 bench 并自动登记（与 `record` 同一套校验），流式日志落 `exp-run.log`，失败即停、中断可续；`pnpm exp pull` 用只读客户端按 runId 回读远端遥测，与本地 `report.json` 逐项对账后把摘要写进台账；`pnpm exp decide` 记录人的结论与理由。判定阈值是 `max(两组自身极差, 100/题数)`，`attempts < 2` 直接 inconclusive——这是 P3-2 落地前的临时口径，**不能替代配对检验**，只能用于排除明显变差。

**仍未完成**（按缺口清单）：`bench compare` 与 `benchmarks/baselines/`（跨实验复用基线，避免每次都重跑 base）、配对 McNemar / 成本 bootstrap（P3-2）、dev/holdout 套件、`bench gate` 与 CI、`bench analysis` 诊断汇总、线上遥测的 commit/experimentId 归因。因此 `pull` 目前回读的是 `kind=benchmark` 跑批事件，只能证明「远端与本地说的是同一件事」，还不能验证上线后的真实用户效果。

第一批用它验证的候选（既有报告已指出、且有现成信号）：P1-7 上下文预算与 step 上限（看 `maxStepInputTokens`、aborted、max_tokens 三类桶）、P1-8 请求超时与退避（看 `infra_error` 与 tool_error_rate）。这两个如果跑不出可判定的差异，说明体系还没到位，先别去碰 prompt。

## 5. 风险与取舍

1. **SWE-bench Lite 可能已被训练语料覆盖**（文档自己也提到）。它适合做粗粒度回归，不适合做优化主信号。缓解：Lite 只做回归护栏，优化信号以 dev + 自建题 + 能力场景为主，逐步把自建题扩到 30 题并打上 capability 标签。
2. **成本与置信度冲突。** 加重复次数才有统计意义，但成本线性增长。取舍：只在 smoke 上做 k=3，dev 做单次 + 配对检验，full 只在发版跑。
3. **轨迹指标容易变成 KPI。** step 数、工具调用数可被压低而变差。约束：过程指标只做诊断，不做门禁；门禁只看通过率与 p50 成本。
4. **scripted 场景会退化成测 mock。** 它只保证控制面契约，不保证效果。约束：能力结论必须 live 复核，scripted 只做回归。
5. **不引入 LLM-as-judge 打分**（本阶段）。没有稳定 rubric 时它带来的是不可复现的分数。等结构化指标进入平台期，再对开放式产物（自媒体题）引入 judge，并要求 judge 自身有金标一致性校验。

## 6. 里程碑与工作量

| 阶段 | 内容 | 规模 | 前置 |
|---|---|---|---|
| P0 | manifest、分布指标、shard/resume/merge、doctor | 中 | 无 |
| P1 | TraceSummary、失败分类、产物保留、analysis | 中 | P0 |
| P2 | 套件分层、agent 并发、缓存预热 | 小 | P0 |
| P3 | repeat、compare、gate、baseline、CI | 中 | P1+P2 |
| P4 | BenchProfile、scripted/live、能力场景、schema v2 | 大 | P1 |
| P5 | 评测自检 | 小 | P1 |

建议先交付 P0+P1（一轮跑批就能拿到失败分类与过程指标），此时体系已经能回答"哪里最该改"；P3 交付后才能回答"改完是否真的更好"；P4 决定这套体系能否覆盖项目真正的差异化能力。
