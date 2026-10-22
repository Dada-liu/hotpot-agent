# benchmarks 移至根级目录

- 日期：2026-10-22
- 状态：已合入工作区（提交时未推送；本地 main 领先 origin）

## 背景与动机

`@hotpot/benchmarks` 是开发/评测工具，不是运行时包，却一直放在 `packages/` 下带来两类混乱：`packages/README.md` 的包数量计数要把它算进去；文档里「几个包」「三题还是四类题」的口径常因它漂移。移到根级与 `packages/` 并列后，packages/ 只剩真正的运行时包。

## 变更内容

- `git mv packages/benchmarks benchmarks`（历史保留）。
- 构建配置：`pnpm-workspace.yaml` 新增 `- "benchmarks"`；`vitest.config.ts` include 增加 `benchmarks/test/**`；根 `package.json` 的 `bench` 脚本改为 `tsx benchmarks/src/cli.ts`；`benchmarks/tsconfig.json` 的 extends 路径上提一级。
- 约 20 处引用同步：测试内 3 处路径（TASKS_DIR + 2 个 fixture）、`packages/AGENTS.md`、根 README 中英文（含目录树）、`docs/README.md`、`docs/benchmark-authoring.md` ×4、官网文档 ×3、项目 skill `running-benchmarks` ×2。
- 文案口径统一：残留「自建三题」改为「自建题三类」（README 中英文、官网、skill）。
- 刻意不动：`docs/archive/`、`docs/superpowers/plans|specs/`（历史记录）与 `website/doc_build/`（构建产物）。

## 影响面

- 本地：所有 import 走包名（`workspace:*`）不受影响；影响的是路径型引用（脚本、include、文档、skill）。
- macmini 远端：`~/hotpot-agent` 同步后删除残留旧目录 `packages/benchmarks` 并重跑 `pnpm install` 刷新链接。
- 历史 plan.ts typecheck 修复（`"id" in e` 收窄，源自首轮流变更的 `scanWindowStart`）随本次全量验证一并落盘。

## 验证

- `pnpm install` 后 lockfile 中 importers 为 `benchmarks:`。
- `pnpm test` 574/574（确认 benchmarks 的 32 个测试在新 include 下照常收集）；`pnpm typecheck`、biome 干净。
- macmini 冒烟：`pnpm bench custom --domain finance` 在新布局下 1/1 通过。

## 相关链接

- 目录规范见 `benchmarks/AGENTS.md`；跑批操作见项目 skill `.kimi-code/skills/running-benchmarks/SKILL.md`。
