# M5 Benchmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add `@hotpot/benchmarks`, a headless runner that generates SWE-bench patches on macmini, invokes the official harness in Docker, and reports pass rate plus token cost; also run three seeded custom tasks (finance / software development / self-media).

**Architecture:** A new workspace package owns instance selection, a `WorkspaceProvider` (plain checkout in M5), a headless agent runner built on `runMainTurn`, prediction generation, official-evaluation orchestration, custom-task execution, and reporting. It is a development tool: `cli` and `server` never import it, and it is not part of the tool bundle. Tests use the scripted adapter; real runs are manual.

**Tech Stack:** Node 22, TypeScript erasable syntax, `@hotpot/core`, `@hotpot/orchestrator`, `@hotpot/ai`, `@hotpot/telemetry`, zod, vitest, git, Python `swebench` + Docker on macmini.

**Spec:** `docs/superpowers/specs/2026-10-18-m5-telemetry-benchmarks-design.md`

## Global Constraints

- Benchmark agent is patch-only in M5: plain checkout, no repo dependency installation, no test execution by the agent.
- Official evaluation uses the official `swebench` harness. Do not reimplement scoring.
- Default acceptance: `SWE-bench_Lite` `test`, 10 instances, `--max-workers 1`, fixed seed.
- `WorkspaceProvider` is the seam for a future container-based runner; the upper runner must not assume checkout details.
- Approval is explicit allow-all for tools, plan auto-approve, and audited; never `policy=never`.
- Benchmark telemetry uses `kind=benchmark` and a dedicated install ID.
- No user content in reports or telemetry; reports contain instance ids, pass/fail, token counts, durations, and sanitized failure reasons only.
- Node >= 22; erasable TypeScript; `.ts` imports; no `any`; no inline imports; comments/README Chinese; AGENTS English.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm exec biome check .` from the repo root before each commit.

## Review Focus

- The workspace has no `.git` or the base commit is missing: the provider fails that instance cleanly and the run continues.
- The agent creates untracked files: `git add -A -N` plus `git diff` must include them in the patch.
- A dangerous command appears: the allow-all handler approves it for the isolated benchmark workspace and writes an audit event.
- The official harness prints progress but the report is missing: the runner exits non-zero with the harness log path, not a false pass.
- Token usage spans main/worker/task: the report sums the whole tree, not just main.

---

### Task 1: Package scaffold and custom task runner

**Files:**
- Create: `packages/benchmarks/package.json`
- Create: `packages/benchmarks/tsconfig.json`
- Create: `packages/benchmarks/src/node-builtins.d.ts`
- Create: `packages/benchmarks/src/custom/task.ts`
- Create: `packages/benchmarks/src/custom/runner.ts`
- Create: `packages/benchmarks/src/index.ts`
- Create: `packages/benchmarks/test/custom-runner.test.ts`
- Modify: `package.json` (add `"bench": "tsx packages/benchmarks/src/cli.ts"`)

**Interfaces:**
- Produces: `CustomTask` with `id`, `domain` (`finance|software|self-media`), `prompt`, `workspace.files`, `validation.command`, `validation.expectedExitCode?`, `validation.expectedStdout?`, `timeoutMs?`.
- Produces: `runCustomTask(task, deps: { runAgent: AgentRunner; workspaceRoot: string }): Promise<CustomTaskResult>`.
- Produces: `AgentRunner = (opts: { cwd: string; prompt: string; timeoutMs?: number }) => Promise<{ inputTokens: number; outputTokens: number }>`.
- Produces: `CustomTaskResult` with `id`, `passed`, `exitCode`, `stdout`, `durationMs`, `inputTokens`, `outputTokens`, `error?`.

- [x] **Step 1: Write the failing test**

Use a fake `runAgent` that writes the expected file into `cwd`, and a validation command `node -e "process.exit(0)"`. Assert `passed: true`. Add a second case where validation exits 1 and assert `passed: false` plus the captured stdout.

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/custom-runner.test.ts`
Expected: FAIL because the package does not exist.

- [x] **Step 3: Create the package and runner**

`package.json` deps: `@hotpot/ai`, `@hotpot/core`, `@hotpot/orchestrator`, `@hotpot/telemetry`, `zod`. `tsconfig.json` extends `../../tsconfig.base.json`, includes `src` and `test`, and adds `"lib": ["es2023", "dom"]`. `node-builtins.d.ts` declares only the `node:fs/promises`, `node:path`, `node:os`, `node:crypto`, and `node:child_process` APIs used here (copy the minimal pattern from `packages/core/src/node-builtins.d.ts`, add `execFile`/`spawn`).

`runCustomTask` creates `<workspaceRoot>/<id>-<random>`, writes `workspace.files`, calls `deps.runAgent({ cwd, prompt, timeoutMs })`, runs `bash -c validation.command` in `cwd`, compares the exit code/stdout, cleans up unless `KEEP_BENCH_WORKSPACE=1`, and returns the result.

- [x] **Step 4: Run the test**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/custom-runner.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add package.json packages/benchmarks
git commit -m "feat(benchmarks): add package and custom task runner"
```

---

### Task 2: Three seeded domain tasks

**Files:**
- Create: `packages/benchmarks/src/custom/tasks/finance-daily-returns.json`
- Create: `packages/benchmarks/src/custom/tasks/software-slugify.json`
- Create: `packages/benchmarks/src/custom/tasks/self-media-plan.json`
- Create: `packages/benchmarks/test/custom-tasks.test.ts`

**Interfaces:**
- Produces three `CustomTask` JSON files discoverable by `loadCustomTasks(dir: string): Promise<CustomTask[]>`.
- Each task is offline, deterministic, and validates with a local `node` script.

- [x] **Step 1: Write the failing tests**

Assert all three parse as `CustomTask`, have unique ids, and their validation scripts pass against a correct fixture output (write the expected file into a temp dir and run the validation).

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/custom-tasks.test.ts`
Expected: FAIL.

- [x] **Step 3: Write the three tasks**

- Finance: `prices.csv` with dates and closes; prompt asks for `returns.json` with `{ "returns": [{ "date": "...", "return": 0.01 }] }`; validation checks length and values within tolerance.
- Software: `slug.js` with a stub and `check.mjs`; prompt asks to implement `slugify`; validation runs `node check.mjs`.
- Self-media: prompt asks for `plan.json` with `title`, `hook`, `outline` (3-5 items), and `hashtags` (3-5); validation checks the JSON schema and lengths.
Each task's `workspace.files` includes every file needed; the validation command is a `node -e` one-liner or a `check.mjs` file in the same workspace.

- [x] **Step 4: Run the tests**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/custom-tasks.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/benchmarks/src/custom/tasks packages/benchmarks/test/custom-tasks.test.ts
git commit -m "feat(benchmarks): seed three domain tasks"
```

---

### Task 3: WorkspaceProvider and patch capture

**Files:**
- Create: `packages/benchmarks/src/workspace.ts`
- Create: `packages/benchmarks/src/swebench/workspace.ts`
- Create: `packages/benchmarks/test/workspace.test.ts`

**Interfaces:**
- Produces: `Workspace` (`cwd`, `cleanup()`), `WorkspaceProvider` (`prepare(instance)`).
- Produces: `CheckoutWorkspaceProvider({ cacheRoot, workspaceRoot })`.
- Produces: `capturePatch(cwd): Promise<string>`.

- [x] **Step 1: Write the failing tests**

Create a temp git repo with one commit; use the provider with a fixture instance; modify a tracked file and add an untracked file; `capturePatch` must include both and must not include `node_modules` or `.hotpot`.

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/workspace.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement the provider**

`CheckoutWorkspaceProvider`: cache clones under `<cacheRoot>/<repo>`; run `git fetch`, then `git worktree add --detach <workspaceRoot>/<instance_id> <base_commit>` so concurrent instances do not share a working tree. `cleanup()` runs `git worktree remove --force <path>` and `git worktree prune`. `capturePatch`: run `git add -A -N`, then `git diff --no-color -- . ':!node_modules' ':!.hotpot'`; return the diff text. `cleanup()` removes the worktree and prunes it.

- [x] **Step 4: Run the tests**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/workspace.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/benchmarks/src/workspace.ts packages/benchmarks/src/swebench/workspace.ts packages/benchmarks/test/workspace.test.ts
git commit -m "feat(benchmarks): add checkout workspace and patch capture"
```

---

### Task 4: Headless agent runner with allow-all approvals

**Files:**
- Create: `packages/benchmarks/src/agent-runner.ts`
- Create: `packages/benchmarks/test/agent-runner.test.ts`

**Interfaces:**
- Produces: `runAgentTurn(opts: { cwd: string; prompt: string; settings?: Settings; modelTier: ModelTier; timeoutMs?: number; adapter?: LlmAdapter; model?: ModelInfo }): Promise<AgentTurnResult>`; when `settings` is omitted, load it with `loadSettings()`.
- `AgentTurnResult`: `{ outcome: "success"|"error"|"aborted"; inputTokens: number; outputTokens: number; durationMs: number; sessionFilePath: string }`.
- Uses `createSession(cwd, tempHome)`, `createRuntime`, `ApprovalChain` with `use(async () => "allow")`, and `runMainTurn({ onPlanApproval: async () => ({ kind: "approve" }) })`.

- [x] **Step 1: Write the failing test**

Use `scriptedAdapter` from `@hotpot/ai` with one text round. Call `runAgentTurn` with a temp home and a temp cwd; assert `outcome: "success"`, token totals from the scripted usage event, and that the session JSONL exists. Add a second test with a dangerous command round (`rm -rf ./fixture-dir` inside the temp cwd): assert the tool result is not denied and an `approval/asked`/`approval/decided` pair exists. Add an abort test: a never-ending adapter + `timeoutMs: 50` returns `aborted`.

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/agent-runner.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement the runner**

- `settings = loadSettings()` (real user settings) unless `opts.settings` is injected;
- `tempHome = await mkdtemp(join(tmpdir(), "hotpot-bench-"))`;
- `session = await createSession(cwd, tempHome)`;
- `approval = new ApprovalChain(); approval.use(async () => "allow");`
- `runtime = createRuntime({ session, cwd, approval, models: settings.models, maxParallelTasks: 1, features: { todo: false, hooks: false, skills: false, promptTemplates: false, webSearch: false, webFetch: false, mcp: false } })`;
- if `opts.adapter` and `opts.model` are provided, wrap the runtime as `{ ...runtime, resolveModel: () => ({ adapter: opts.adapter!, model: opts.model!, apiKey: "test" }) }` so scripted tests use the injected adapter;
- `ac = new AbortController(); timer = setTimeout(() => ac.abort(), timeoutMs ?? 600000)`;
- iterate `runMainTurn({ runtime, userMessage: prompt, signal: ac.signal, mainTier: modelTier, onPlanApproval: async () => ({ kind: "approve" }) })`, tracking `done`, `error`, and `agent_spawn`;
- after the loop, load the session and sum `assistant_msg.usage` across all agents; return the result. Clear the timer in `finally`.

- [x] **Step 4: Run the tests**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/agent-runner.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/benchmarks/src/agent-runner.ts packages/benchmarks/test/agent-runner.test.ts
git commit -m "feat(benchmarks): add headless agent runner"
```

---

### Task 5: SWE-bench instance export and selection

**Files:**
- Create: `packages/benchmarks/scripts/export_instances.py`
- Create: `packages/benchmarks/src/swebench/instances.ts`
- Create: `packages/benchmarks/test/instances.test.ts`
- Create: `packages/benchmarks/test/fixtures/instances.jsonl`

**Interfaces:**
- Produces: `SwebenchInstance` with `instance_id`, `repo`, `base_commit`, `problem_statement`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `version`.
- Produces: `loadInstances(file): Promise<SwebenchInstance[]>`, `selectInstances(instances, { limit, instanceIds, seed })`.
- Python script args: `--dataset`, `--split`, `--limit`, `--instance-ids`, `--output`.

- [x] **Step 1: Write the failing tests**

Fixture JSONL with five instances. Assert `loadInstances` parses; `selectInstances` honors `limit: 2`, explicit ids, and a deterministic seed; unknown ids throw a clear error.

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/instances.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

Python: `from datasets import load_dataset`; set `HF_ENDPOINT` externally; write one JSON object per line with the seven fields. Node: parse JSONL, validate required fields, select by ids or deterministic shuffle with a small seeded PRNG (e.g., mulberry32), then slice. Document `HF_ENDPOINT=https://hf-mirror.com` in the script header.

- [x] **Step 4: Run the tests**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/instances.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/benchmarks/scripts packages/benchmarks/src/swebench/instances.ts packages/benchmarks/test
git commit -m "feat(benchmarks): add swebench instance export and selection"
```

---

### Task 6: Predictions and official evaluation orchestration

**Files:**
- Create: `packages/benchmarks/src/swebench/predictions.ts`
- Create: `packages/benchmarks/src/swebench/evaluate.ts`
- Create: `packages/benchmarks/test/predictions.test.ts`
- Create: `packages/benchmarks/test/evaluate.test.ts`

**Interfaces:**
- Produces: `writePredictions(file, entries: { instanceId: string; patch: string }[]): Promise<void>`.
- Produces: `buildEvaluationCommand(opts: { dataset: string; split: string; predictionsPath: string; maxWorkers: number; runId: string; reportDir: string }): string[]`.
- Produces: `runOfficialEvaluation(opts: { mode: "local"|"remote"; host: string; dataset: string; split: string; predictionsPath: string; maxWorkers: number; runId: string; reportDir: string; cwd: string }): Promise<OfficialReport>`.
- Produces: `parseOfficialReport(file): OfficialReport`, where `OfficialReport = { runId: string; resolved: string[]; unresolved: string[]; emptyPatch: string[] }`.

- [x] **Step 1: Write the failing tests**

Predictions: exact JSONL keys `instance_id`, `model_name_or_path`, `model_patch`; newline-delimited; empty patch preserved as an empty string.
Evaluation: `buildEvaluationCommand` produces the official `python -m swebench.harness.run_evaluation` args with dataset/split/predictions/max_workers/run_id/report_dir. `parseOfficialReport` reads a fixture and returns resolved/unresolved counts and per-instance results.

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/predictions.test.ts test/evaluate.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

`writePredictions` writes `{instance_id, model_name_or_path:"hotpot-code", model_patch}` per line. `buildEvaluationCommand` returns the exact argv. `runOfficialEvaluation`:
- local: spawn the command in `cwd`, stream output to a log file, wait for exit, then parse the report;
- remote: `rsync` the predictions and a small runner script to `host`, run it in `tmux new -d -s <runId>`, poll `tmux has-session`, then `rsync` the report back. macmini does not have tmux preinstalled; install it with Homebrew or use `nohup` as the fallback.
Both paths return non-zero when the report is missing or the exit code is non-zero. Tests only cover command construction and report parsing; do not run SSH/Docker.

- [x] **Step 4: Run the tests**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/predictions.test.ts test/evaluate.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/benchmarks/src/swebench/predictions.ts packages/benchmarks/src/swebench/evaluate.ts packages/benchmarks/test
git commit -m "feat(benchmarks): add predictions and official evaluation"
```

---

### Task 7: Report and one-click CLI

**Files:**
- Create: `packages/benchmarks/src/report.ts`
- Create: `packages/benchmarks/src/cli.ts`
- Create: `packages/benchmarks/test/report.test.ts`
- Create: `packages/benchmarks/test/cli.test.ts`

**Interfaces:**
- Produces: `buildReport(results: InstanceResult[], official?: OfficialReport): BenchmarkReport`.
- Produces CLI: `pnpm bench swebench --limit 10 ...` and `pnpm bench custom --domain finance`.
- `BenchmarkReport` includes `suite`, `dataset`, `split`, `total`, `passed`, `passRate`, `avgInputTokens`, `avgOutputTokens`, `avgDurationMs`, `instances`.

- [x] **Step 1: Write the failing tests**

Report: fixture results with mixed pass/fail and usage; assert counts, averages, and failure reasons. CLI: parse `--limit`, `--instance-ids`, `--eval-mode`, `--eval-host`, `--domain`; unknown option exits non-zero with usage.

- [x] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/report.test.ts test/cli.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

`buildReport` writes `report.json` and `report.md`. CLI dispatches `swebench` (instances → workspace → agent → predictions → evaluate → report) and `custom` (load tasks → runner → report). `--output` defaults to `./benchmark-runs/<timestamp>/`. Print a one-line summary and the report paths to stdout.

- [x] **Step 4: Run the tests and help output**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/report.test.ts test/cli.test.ts`
Expected: PASS.
Run: `pnpm bench --help`
Expected: usage text with both suites.

- [x] **Step 5: Commit**

```bash
git add packages/benchmarks/src/report.ts packages/benchmarks/src/cli.ts packages/benchmarks/test
git commit -m "feat(benchmarks): add report and cli"
```

---

### Task 8: Benchmark telemetry

**Files:**
- Create: `packages/benchmarks/src/telemetry.ts`
- Create: `packages/benchmarks/test/telemetry.test.ts`

**Interfaces:**
- Produces: `reportBenchmarkRun(settings, result: InstanceResult, deps?: { fetchImpl?: typeof fetch }): Promise<void>`.
- Uses `@hotpot/telemetry` with `kind: "benchmark"` and the benchmark install ID.

- [x] **Step 1: Write the failing test**

Fake fetch captures the body; assert `kind: "benchmark"`, one `benchmark_run` event with dataset/split/instanceId/passed/duration/tokens, and no prompt or patch fields.

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/telemetry.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

Resolve telemetry settings like the client runtime, but force `kind: "benchmark"`; create a client per run (or reuse one if the CLI already created it), enqueue the event, flush, and close. If telemetry is disabled or the endpoint is empty, no-op.

- [x] **Step 4: Run the test**

Run: `pnpm --filter @hotpot/benchmarks exec vitest run test/telemetry.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/benchmarks/src/telemetry.ts packages/benchmarks/test/telemetry.test.ts
git commit -m "feat(benchmarks): report benchmark runs as telemetry"
```

---

### Task 9: Docs and final verification

**Files:**
- Create: `packages/benchmarks/README.md`
- Create: `packages/benchmarks/AGENTS.md`
- Create: `docs/benchmark-authoring.md`
- Create: `docs/archive/05-m5-telemetry-benchmarks.md`
- Modify: `docs/README.md` (reading order)
- Modify: `README.md` (directory tree and package list)
- Modify: `docs/archive/04-roadmap.md` (M5 benchmark status)

- [x] **Step 1: Write package docs**

README covers the two suites, the patch-only baseline, the 10-instance default, the macmini host split, `HF_ENDPOINT`, registry mirrors, and report fields. AGENTS covers the no-reimplement rule, workspace provider seam, allow-all audit, hermetic tests, and report privacy.

- [x] **Step 2: Write authoring and operations docs**

`docs/benchmark-authoring.md`: 筛选历史会话 → 脱敏 → 题目化 → 校验脚本 → 回归。`docs/archive/05-m5-telemetry-benchmarks.md`: event schema summary, admin deployment, benchmark commands, host roles, and failure recovery.

- [x] **Step 3: Run the full verification**

Run: `pnpm typecheck`
Expected: no errors.
Run: `pnpm test`
Expected: all tests pass.
Run: `pnpm exec biome check .`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add packages/benchmarks docs README.md
git commit -m "docs(benchmarks): document M5 benchmark workflow"
```

---

### Task 10: Record/replay test helper

**Files:**
- Create: `packages/ai/src/testing/record-replay.ts`
- Create: `packages/ai/src/testing/node-builtins.d.ts` (minimal `node:fs/promises` declarations)
- Create: `packages/ai/test/record-replay.test.ts`
- Modify: `packages/ai/src/index.ts` (export the helper)
- Modify: `packages/ai/src/testing/README.md` / `AGENTS.md`

**Interfaces:**
- Produces: `createRecordingAdapter(inner: LlmAdapter, file: string): LlmAdapter`.
- Produces: `createReplayAdapter(file: string): LlmAdapter`.
- Recording format: one JSON line per `streamChat` call containing `{ request: ChatRequest, events: StreamEvent[] }`.
- Recordings are local test fixtures. Do not commit a recording that contains real user prompts or replies.

- [x] **Step 1: Write the failing test**

Use `scriptedAdapter` with one text round. Record it to a temp file with `createRecordingAdapter(inner, file)`, then replay with `createReplayAdapter(file)` and collect the events. Assert both streams are deep-equal. Add an exhaustion test: replaying twice throws on the second call.

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @hotpot/ai exec vitest run test/record-replay.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement the helper**

Recording: return `{ api: inner.api, async *streamChat(req, signal) { const events = []; for await (const e of inner.streamChat(req, signal)) { events.push(e); yield e; } await appendFile(file, JSON.stringify({ request: req, events }) + "\n"); } }`. Replay: read the file, parse lines, keep a cursor; each `streamChat` yields the next line's events and throws `replay adapter exhausted` when the cursor runs past the end. Add minimal ambient declarations for `appendFile`/`readFile` in `node-builtins.d.ts`; the AI package does not use `@types/node`.

- [x] **Step 4: Run the test**

Run: `pnpm --filter @hotpot/ai exec vitest run test/record-replay.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/ai
git commit -m "test(ai): add record and replay adapter"
```

---

### Task 11: Operational acceptance on macmini

**Files:**
- Modify: `docs/archive/04-roadmap.md` (record acceptance)

- [x] **Step 1: Install the toolchain on macmini**

Install Node 22 + pnpm (nvm or Homebrew). Sync the repo with `rsync -avzP --exclude node_modules --exclude .git ./ macmini:~/hotpot-code/`, then run `pnpm install` and `pnpm test`.

- [x] **Step 2: Install the SWE-bench venv**

Install Python 3.11/3.12 on macmini (e.g. `uv python install 3.12` or Homebrew), then `python3.12 -m venv ~/swebench-venv`, `~/swebench-venv/bin/pip install swebench`, and export `HF_ENDPOINT=https://hf-mirror.com`. Confirm `docker pull hello-world` works through the configured registry mirror.

- [x] **Step 3: Export 10 Lite instances**

Run `packages/benchmarks/scripts/export_instances.py --dataset princeton-nlp/SWE-bench_Lite --split test --limit 10 --output instances.jsonl` from the repo root, using the venv interpreter. If the dataset name differs in the harness version, use the harness's dataset name.

- [ ] **Step 4: Run the acceptance benchmark**

Run `pnpm bench swebench --limit 10 --instances-file instances.jsonl --eval-mode local --eval-host macmini --max-workers 1`. Preflight with 1 instance first; record image size, memory, and duration. Stop and record if disk < 20G, memory pressure, or amd64 emulation is unusable; fall back to `sell_system` or a larger Linux host. Then run the remaining 9 with cleanup between batches.

- [ ] **Step 5: Record the result**

Append the run id, dataset/split, pass rate, average input/output tokens, average duration, failure count, and the patch-only caveat to `docs/archive/04-roadmap.md`. Do not commit generated patches, predictions, or model outputs.

- [ ] **Step 6: Commit**

```bash
git add docs/archive/04-roadmap.md
git commit -m "docs(benchmarks): record Lite 10 acceptance"
```

> **执行记录（2026-10-19）**：Task 11 Step 1-3 已完成。macmini 使用 Node v24.21.0（fnm）、pnpm 10.33.0、Python 3.12.15（uv）、swebench 5.0.2；`pnpm test` 在 `--maxWorkers=4` 下 64 文件 / 539 用例通过（默认 64 worker 并发会触发 orchestrator `spawn-tasks` 的既有计时 flake，单文件重跑通过）。Lite 300 条实例已导出，`--limit 10 --seed 0` 选中 10 题。官方 harness 预检：empty patch 正确记为 `empty_patch_ids`；gold patch（astropy__astropy-12907）在 amd64 模拟下 resolved，镜像 4.16GB（pull 200s），单题评测 437s，容器内存峰值约 235MB。**Step 4 阻塞**：macmini 没有 `~/.hotpot/settings.json`，也没有 provider 环境变量，agent 阶段无法运行；未伪造凭证，因此 10 题通过率与 token 成本未产生。补齐用户级 settings 后按 Step 4 命令重跑即可。Step 5 的验收数字因此暂缺，Step 6 尚未提交。
