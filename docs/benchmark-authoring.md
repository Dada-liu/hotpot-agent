# 自建 benchmark 题目沉淀流程

本流程把一次真实使用（历史会话）沉淀为可重复运行的离线题目，进入 `packages/benchmarks/src/custom/tasks/`。目标是让「改动后是否变好」可度量，而不是收集尽可能多的题。

题目必须离线、确定性、无网络：校验脚本只依赖题目自带的 `workspace.files`，不装依赖、不访问外部服务。题目 prompt 会传给 LLM，按仓库约定用英文；文件内容、校验脚本注释用中文或英文均可，但不得包含真实用户数据。

## 1. 筛选历史会话

从 `~/.hotpot/sessions/**/*.jsonl` 里挑候选，满足以下条件：

- 有明确、可验证的最终产物（文件、JSON、函数、补丁），而不是开放式讨论。
- 在干净环境里能独立完成：不依赖会话中已安装的包、已启动的服务、本机路径或登录态。
- 规模适中：正常 agent 5-30 分钟能完成；太大就拆成多题。
- 失败模式有代表性：题目要能区分「会做」和「不会做」，避免一句话就能过的送分题。
- 不包含敏感业务：客户名、内部域名、真实数据、私钥、个人联系方式。

建议先记录：会话文件、任务一句话、期望产物、人工耗时、当时失败/成功原因。

## 2. 脱敏

把会话里可复用的部分抽出来后，逐项替换：

- 路径、用户名、机器名 → 相对路径或占位符。
- 公司/客户/项目名 → 通用名称（如 `acme`、`example`）。
- 真实数据 → 合成数据；数值要能算出确定答案。
- 图片/表格/附件 → 内联为小文本文件，或改成生成规则明确的合成文件。
- prompt 中删掉「我上次让你…」「我们内部系统…」等只有原会话才懂的上下文。

脱敏后自查：把题目交给一个没见过原会话的人，他能否只凭 `prompt + workspace.files` 完成？不能则题目不完整。

## 3. 题目化

每题一个 JSON 文件，字段用 `packages/benchmarks/src/custom/task.ts` 的 schema（`.strict()`，拼错字段会直接报错）：

```json
{
  "id": "domain-short-name",
  "domain": "finance | software | self-media",
  "prompt": "English instructions passed to the agent.",
  "workspace": {
    "files": {
      "input.csv": "a,b\n1,2\n",
      "check.mjs": "// 校验脚本，随题目一起写入 workspace"
    }
  },
  "validation": {
    "command": "node check.mjs",
    "expectedExitCode": 0,
    "expectedStdout": "ok"
  },
  "timeoutMs": 300000
}
```

约定：

- `id` 全局唯一，建议 `<domain>-<动作>`，如 `finance-daily-returns`。
- `prompt` 说清楚输入文件、输出文件、精确口径（排序、单位、舍入、字段名）和禁止事项；不要提示实现步骤。
- `workspace.files` 必须自带校验所需全部文件；可以包含 `package.json`（`{"type":"module"}`）让 `.js` 按 ESM 解析。
- `validation.expectedStdout` 用「stdout 包含该子串」判定，不解析测试框架输出。
- `timeoutMs` 同时约束 agent 与校验命令；默认 5 分钟量级。

## 4. 校验脚本

校验脚本是题目的另一半，必须满足：

- 只读 workspace 内文件，不联网、不装依赖；用 `node check.mjs` 或 `node -e`。
- 成功时退出 0，并在 stdout 打印固定标记（如 `finance ok`）；失败时退出非 0 并打印可定位原因（第几行、期望/实际）。
- 校验的是题面口径，不是实现细节：数值题给容差（如 `1e-6`），函数题用行为用例，结构题校验字段/长度/关键词。
- 必须写负例：桩实现、缺文件、错误数值时校验要失败。当前三题在 `packages/benchmarks/test/custom-tasks.test.ts` 中覆盖了金融与软件的负例。
- 不要把答案写进 `check.mjs` 能被人一眼抄走的位置也无所谓——benchmark 衡量 agent，不衡量防作弊；但答案不要出现在 `prompt` 或初始文件里。

## 5. 回归

新题合入前：

1. 用正确产物手工跑校验，确认退出 0。
2. 用桩/缺失产物跑校验，确认失败。
3. 跑 `pnpm bench custom --domain <domain>`（需要 `~/.hotpot/settings.json` 的 LLM 凭证），确认 agent 能读取题目并产出文件。
4. 在 `packages/benchmarks/test/custom-tasks.test.ts` 增加该题的「正确产物通过 + 至少一个负例」用例；测试必须 hermetic。
5. 跑 `pnpm test`、`pnpm typecheck`、`pnpm exec biome check .`。
6. 在 `docs/archive/04-roadmap.md` 或本文件的「题库」表里登记题目、口径与已知边界。

## 题库登记

| id | 领域 | 产物 | 校验口径 | 已知边界 |
|----|------|------|----------|----------|
| `finance-daily-returns` | 金融 | `returns.json` | 3 行日收益率，日期精确、数值容差 `1e-6` | 只覆盖简单收益率与舍入 |
| `software-slugify` | 软件开发 | `slug.js` | `check.mjs` 五个行为用例 | 只覆盖 ASCII 输入 |
| `self-media-plan` | 自媒体 | `plan.json` | 字段/长度/标签格式 + 关键词 `camping` | 不评估内容质量，只评估结构约束 |

新增题目按上表追加一行。

## 反例（不要收）

- 需要联网搜索、调用外部 API、登录态才能完成的任务。
- 依赖特定机器环境（Docker、GPU、本机数据库）的任务。
- 产物无法机器校验（「写一篇好文章」）或校验只能靠主观判断。
- 包含真实用户数据、公司内部信息、密钥的任务。
- 已经能从公开 benchmark 找到原题与答案的题目（除非作为对照）。
