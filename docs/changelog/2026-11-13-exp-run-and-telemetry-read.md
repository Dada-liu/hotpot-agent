# `exp run` 双版本跑批编排与遥测只读回读

- 日期：2026-11-13
- 状态：进行中（工作区未提交）

## 背景与动机

上一版脚手架（`pnpm exp new` / `record`）把「需求 → 一对 worktree」和「决策留痕」补齐了，但中间两段仍靠人拼：

- `new` 只**打印**两段 `pnpm bench`，人要复制到两个终端、各装一次依赖、各跑一轮，再手动 `record` 两次。中断、跑错目录、忘了 `--repeat` 都没人管；
- 遥测只有**写**侧（`@hotpot/telemetry` 上报），服务端读接口全在 admin 会话下，仓库里没有任何查询客户端。「拉远程遥测数据」只能打开网页点，脚本拿不到，更无法与本地 `report.json` 对账。

这两件事决定流程是「一次实验 4 条命令 + 一次网页操作」还是「一条命令 + 一张对照表」。

## 变更内容

### 一条命令跑完两轮

- 新增 `pnpm exp run <slug>`（`src/experiment/run.ts`）：开跑前拦掉实例文件缺失、worktree 脏、基线 worktree HEAD 偏离 `baseCommit`、已有产物与当前提交/`repeat` 不符；然后按 base → head 顺序，在每个 worktree 执行 `pnpm install` 与 `pnpm bench swebench --suite <台账套件> --repeat <k> --output <绝对路径>`。
- 子进程输出同时进控制台与 `<runDir>/exp-run.log`。任一变体失败立即停止，**不登记任何东西**；修好后重跑同一条命令会复用已完成变体、给未完成的加 `--resume`。`--force` 把旧目录整目录 rename 成 `.bak-<时间>`，不覆盖。
- 成功后调用 `registerRun`（从原 `record` 抽出，与手工登记同一套校验）自动登记两轮；证据变化时清掉旧的 `comparison` 与 `telemetry` 快照，避免结论对应过期证据。
- `bench swebench` 新增 `--suite <name>`：`exp run` 必须显式指定台账记录的套件，不能依赖 CLI 默认值（将来默认换了会静默换题）。
- 选项：`--variants`、`--skip-install`、`--dry-run`、`--no-record`、`--pull`、`--eval-mode/--eval-host/--max-workers`。

### 遥测只读客户端与对账

- 新增 `src/telemetry-read.ts`：`POST /api/v1/login` 换 `hp_admin` cookie → `GET /api/v1/benchmarks` 与 `/api/v1/benchmarks/:runId/instances`。与上报侧完全解耦（上报用 ingestToken）；密码只从环境变量读、cookie 只在内存里，不落盘不打印。响应按 zod schema 校验，超时/401/429/网络错误/形状错误分类报错。
- 新增 `pnpm exp pull <slug>`（`src/experiment/pull.ts`）：按台账 `runId` 把远端摘要与本地 `report.json` 比对题数、尝试数、通过次数、通过率、`resolvedInstances`、flaky 题数与逐题 flaky 集合，给 `ok` / `missing` / `mismatch` 三态。完整明细落 `benchmark-runs/experiments/<slug>/telemetry.json`，摘要写进台账 `telemetry` 字段并渲染到 `<slug>.md`；`exp show` 也能看到。`mismatch`/`missing` 退出码 1。
- 台账新增可选字段 `telemetry`（`ExperimentTelemetry`）。重跑跑批时该快照自动失效，要求重新 pull。
- `exp run --pull` 把跑批、登记、回读串成一条命令；回读失败只告警，不推翻已成功的跑批。

## 取舍

- **不改遥测服务端**：读接口已存在且完整（v3 的 `benchmark_attempts` 投影表提供了 instances/attempts/flaky），用 admin 登录换 cookie 就能读，避免与正在进行的部署冲突。代价是脚本需要 admin 凭据；若要更干净，应由服务端另加只读 token，那是一次独立变更。
- **默认串行**：两版同时跑会争用同一模型额度，让噪声更大；并发属于之后的 agent 级并行基建。
- **对账只报告，不改结论**：`pull` 不改写任何通过率。远端丢事件时，人来决定重拉还是重跑。

## 影响面

- `benchmarks` 新增 `src/telemetry-read.ts`、`src/experiment/{record,run,pull}.ts`；`src/experiment/cli.ts` 增加 `run`/`pull` 子命令，`ledger.ts` 增加遥测段渲染，`types.ts` 增加可选字段。
- `src/cli-args.ts` / `src/cli.ts` 增加 `--suite`；`src/node-builtins.d.ts` 补 `appendFileSync` 的最小声明。
- 文档：`benchmarks/README.md`、`docs/experiments/README.md`、`docs/eval-system-plan.md` §4、`benchmarks/AGENTS.md`。
- 不影响既有 `pnpm bench` 默认行为（不传 `--suite` 仍是 lite10），也不影响发布产物。

## 验证

- 新增 `benchmarks/test/experiment-run.test.ts` 10 个用例（临时 git 仓库 + 真实 worktree + 注入子进程执行器）：dry-run 不执行、实例文件缺失早拦、两轮顺序执行与日志落盘、自动登记出对比、失败即停不登记、跳过已完成/续跑未完成、`--force` 保留旧产物、pull 一致/mismatch/missing、`run --pull` 串联。
- 新增 `benchmarks/test/telemetry-read.test.ts` 6 个用例（注入 fetch，不触网）：缺凭据、登录换 cookie 与查询参数、401/429 分类、旧服务端响应拒绝、明细 URL 编码、默认窗口覆盖。
- `pnpm test` 816 通过；`pnpm typecheck`、`pnpm exec biome check .` 全绿。

## 相关链接

- 台账与闭环：[docs/experiments/README.md](../../docs/experiments/README.md)
- 评测计划：[docs/eval-system-plan.md](../../docs/eval-system-plan.md)
- 实现：[benchmarks/src/experiment/](../../benchmarks/src/experiment/)、[benchmarks/src/telemetry-read.ts](../../benchmarks/src/telemetry-read.ts)
