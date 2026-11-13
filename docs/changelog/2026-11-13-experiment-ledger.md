# 实验台账与 `pnpm exp` 脚手架

- 日期：2026-11-13
- 状态：进行中（工作区未提交）

## 背景与动机

「新增/删除一个功能 → 新开 worktree → 两版跑 benchmark → 拉数据对比 → 人决策」这条流程里，中间三段已有基础（`manifest.json`、分片/续跑/合并、`--repeat` 与波动口径），但首尾两段是空的：

- 开会话靠手敲 `git worktree add`，分支命名、基线提交、目录位置每次都不一样；
- `.worktrees/` 下积了 6 个目录，没有一个文件说明各自在验证什么假设；
- 「这版比那版好」只能两个人各看一个百分数，没有地方记「基线是哪一轮、条件是否一致、最后谁拍的板」。

结果是实验本身不可追溯：过一个星期，没人能复现「当时凭什么判」。

## 变更内容

新增 `benchmarks/src/experiment/`（`pnpm exp`），把实验从「需求」到「决策」收成一条台账记录：

- `pnpm exp new <slug> --hypothesis "..."`：建 `exp/<slug>` 分支与 `.worktrees/<slug>`；同时建 `.worktrees/<slug>-base`，**detached 在 baseCommit**，让基线不会随 main 前进而漂移。写 `docs/experiments/registry.json`（唯一事实源）与渲染视图 `docs/experiments/<slug>.md`，并打印两段可直接执行的 `pnpm bench`（共用同一份实例文件与 `--repeat`）。
- `pnpm exp record <slug> --variant base|head`：登记跑批。拒绝：`status != completed`、跑批时工作区脏、base 提交不等于台账 `baseCommit`、head 提交不等于 worktree HEAD、`repeat` 不一致、两轮条件在 `describeManifestDiff(..., { ignoreIdentity: true })` 下仍有差异。
- 两轮齐了自动给方向结论：差异必须超过 `max(两组自身极差, 100/题数)` 才是 `better`/`worse`，`attempts < 2` 直接 `inconclusive`。这不是显著性检验（McNemar 未实现），只用于排除明显变差。
- `pnpm exp decide` / `close`：决策与理由留痕；回收 worktree 但保留分支，脏工作区需 `--force`。
- 跑批产物落在 `benchmark-runs/experiments/<slug>/{base,head}`，**不放在 worktree 内**——worktree 会被回收，产物要活下来。该目录加入 `.gitignore`。
- `describeManifestDiff` 新增 `ignoreIdentity` 选项：同一实验的 base/head 必然在提交与包版本上不同，比较改动效果时忽略这两项，其余条件仍必须一致。

## 影响面

- 新增根脚本 `pnpm exp`；`benchmarks` 包新增 `src/experiment/`，不进入发布产物。
- 新增 `docs/experiments/`（`registry.json` + `<slug>.md`）；`docs/README.md`、`docs/eval-system-plan.md` §4、`benchmarks/README.md`、`benchmarks/AGENTS.md` 同步。
- `benchmark-runs/` 由「未跟踪」改为 gitignore：跑批产物不再出现在 `git status` 里，人工报告仍按约定提交到 `docs/benchmark-reports/`。
- 不影响 `pnpm bench` 既有行为与小模块 API。

## 验证

- 新增 `benchmarks/test/experiment.test.ts` 15 个用例，全部在临时 git 仓库里跑：建 worktree 与 detached 基线、重复 slug/非法 slug/缺假设拒绝、dry-run 不落盘、base 提交漂移与重复次数不一致拒绝、两轮条件不一致拒绝、inconclusive 判定（+10pp 正好等于单题刻度）、决策必须有理由、已决策实验拒绝追加证据、close 保留分支、脏工作区拒绝回收。
- `pnpm test` 800 通过；`pnpm typecheck`、`pnpm exec biome check .` 全绿。
- 手工走了一遍 `new → record ×2 → show → list`，核对渲染的 `<slug>.md` 与逐题翻转输出。

## 相关链接

- 台账说明：[docs/experiments/README.md](../../docs/experiments/README.md)
- 评测计划闭环接口：[docs/eval-system-plan.md](../../docs/eval-system-plan.md)
- 实现：[benchmarks/src/experiment/](../../benchmarks/src/experiment/)
