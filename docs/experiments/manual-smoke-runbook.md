# 手动验收手册：需求 → 双版本跑批 → 对账 → 决策

> **给执行者（kimi code）**
> 这是一份可直接执行的操作手册，不是背景介绍。按 Step 0 → Step 7 顺序执行，每一步都有「验收判据」。
> 任一步不满足判据就**停下并汇报**，不要跳到下一步，不要自行改动代码或参数去「绕过」问题。
> 不确定的地方停下来问，不要猜。

---

## 1. 任务目标

验证整条评测闭环能否跑通：

```
建实验（两个 worktree） → base/head 各跑一轮 bench → 自动登记并给出对比结论
→ 回读远端遥测并与本地报告对账 → 人写决策 → 回收 worktree
```

本次测的是**链路**，不是某个功能的收益。因此用 `--repeat 1` 省成本，最终结论预期为 `inconclusive`——
那不是失败，是设计如此（1 次尝试没有误差棒，`compare.ts` 直接判 inconclusive）。

---

## 2. 环境事实（执行前先核对，不符就停）

| 项 | 期望值 |
|---|---|
| 仓库根目录 | `/Users/yuliu/Desktop/daxia/code/test-agent/hotpot-agent` |
| 起始提交 | `09d67a4`（`fix(benchmarks): 远程评测脚本补齐 Docker CLI 的 PATH`） |
| 分支 | `main` |
| 评测套件 | `lite10`（`benchmarks/suites/lite10.json`，10 个固定 instance id） |
| 评测方式 | `remote`，主机 `macmini-tailscale`（局域网别名 `macmini` 不通时用这个） |
| 台账现状 | `docs/experiments/registry.json` 为 `{"schemaVersion":1,"experiments":[]}` |
| 预计耗时 | Step 4 约 1.5–2 小时（20 次 agent 尝试） |
| 预计花费 | 约 60–70 元（模型调用；镜像已在远端缓存，不重复拉） |

```bash
REPO=/Users/yuliu/Desktop/daxia/code/test-agent/hotpot-agent
SLUG=manual-smoke
HOST=macmini-tailscale
cd "$REPO" || exit 1
git log --oneline -1
git status --short
```

**判据**：`git log` 首行为 `09d67a4`；`git status` 最多出现 `?? .workbuddy/`（允许）。

- 如果 HEAD 不是 `09d67a4`：先确认 `git log --oneline -5` 里是否包含它。包含则继续（后续提交不影响），不包含则停下汇报。
- 如果 `git status` 出现**已跟踪文件的修改**（`M`/`D`）：停下汇报，不要 `git checkout` 或 stash。
- 如果 `instances.jsonl` 已存在且大小合理（几百 KB 以上）：**跳过 Step 0.1**，直接做 0.2。

---

## 3. 禁止事项（违反其一即视为任务失败）

1. 不要修改任何源码、配置、`benchmarks/suites/lite10.json`、`runtime-profile.ts`。
2. 不要改动 `.worktrees/m4-*`、`.worktrees/pre-delegate`、`.worktrees/telemetry-schema-fix` 这五个**已存在的** worktree（里面可能是别人的未完成工作）。
3. 不要执行 `git commit`、`git push`、`git checkout`、`git reset`、`git stash`。
4. 不要执行 `git worktree remove` / `rm -rf`，唯一的例外是 Step 7 的 `pnpm exp close`。
5. 不要在 Step 4 使用 `--force`（会丢弃已完成的跑批产物）。
6. 不要跑 `--repeat 3`（成本翻三倍，本次不需要）。
7. 不要碰 `hotpot-telemetry` 仓库，不要执行任何 `docker compose` 命令。
8. 不要修改 `.env`、不要试图猜测或读取遥测 admin 密码以外的任何凭据。
9. 不要为了「让它通过」而修改台账 `docs/experiments/registry.json`，该文件只能由 `pnpm exp` 写入。

---

## Step 0 · 前置准备

### 0.1 导出实例（已存在则跳过）

```bash
cd "$REPO"
python3 -m venv ~/hf-venv 2>/dev/null || true
~/hf-venv/bin/pip install -q datasets
HF_ENDPOINT=https://hf-mirror.com ~/hf-venv/bin/python \
  benchmarks/scripts/export_instances.py \
  --dataset SWE-bench/SWE-bench_Lite --split test --output instances.jsonl
```

**它在做什么**：从 HuggingFace 拉整个 SWE-bench Lite test split（300 题）写成 JSONL。
**不要加 `--limit`**：套件 `lite10` 自己钉住 10 个 id，`--limit` 会按 seed 取文件前 n 行，换一份导出文件就会换题，前后无法配对。
`HF_ENDPOINT` 走国内镜像，不加大概率超时。

**判据**：

```bash
wc -l instances.jsonl          # 期望 300
head -1 instances.jsonl | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(d)[:4])"
```

期望输出包含 `['base_commit', 'instance_id', 'problem_statement', 'repo']`。

### 0.2 远端评测主机的探针（不可跳过）

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"; source ~/swebench-venv/bin/activate && python3 -c "import swebench, shutil; print(swebench.__version__, shutil.which(\"docker\"))"'
```

**为什么必须单独验**：`pnpm bench doctor --eval-mode remote` 只检查 ssh 连得通、远端有 `tmux`，**不检查**远端有没有 swebench、Docker daemon 起没起、PATH 里找不找得到 `docker`。而 swebench harness 内部要调 `docker`，找不到会等 agent 全部跑完才失败。

**判据**：输出形如 `5.0.2 /usr/local/bin/docker`。两段都不能为空。
失败时：先把 `$HOST` 换成 `macmini-tailscale` 再试一次；仍失败则停下汇报，附完整错误。

### 0.3 预检

```bash
cd "$REPO"
pnpm bench doctor --instances-file instances.jsonl \
  --eval-mode remote --eval-host "$HOST" 2>&1 | tail -40
```

**判据**：

- 退出码 0；
- 输出中**没有 `fail`**（可以有 `warn`）；
- 已知可忽略的 warn：主工作区 dirty（因为未跟踪的 `.workbuddy/`）、telemetry 相关提示。

失败时：按输出里给出的 `fix` 行处理（它给的是可执行命令）。不要跳过 `fail` 直接往下走。

---

## Step 1 · 建实验

```bash
cd "$REPO"
pnpm exp new "$SLUG" \
  --hypothesis "手动验收：跑通需求→双版本跑批→对账→决策的链路" \
  --requirement "手动验收整条闭环" \
  --repeat 1
```

**它在做什么**（按顺序，任一校验失败会直接报错退出）：

1. 校验 slug、**必须在主工作区执行**（在 worktree 里开实验会让台账跟着分支漂移）；
2. 台账里不能已有同名实验；
3. 分支 `exp/manual-smoke` 不能已存在；
4. 两个目录 `.worktrees/manual-smoke`、`.worktrees/manual-smoke-base` 不能已存在；
5. 解析 `--base`（默认 `main`）为完整 sha，存为 `baseCommit`；
6. 加载套件 `lite10`，把实例文件解析成绝对路径（两轮共用同一份）；
7. 建 worktree：head 挂在新分支上，base **detached 在 `baseCommit`**；
8. 写 `docs/experiments/registry.json` + `docs/experiments/manual-smoke.md`。

**判据**：

```bash
git worktree list | grep manual-smoke
git branch --list "exp/$SLUG"
python3 -c "import json;d=json.load(open('docs/experiments/registry.json'));e=d['experiments'][0];print(e['slug'],e['suite'],e['repeat'],e['baseCommit'][:7],e['status'])"
```

期望：两个 worktree 存在（一个在 `exp/manual-smoke`，一个 detached）；台账输出 `manual-smoke lite10 1 <sha> open`。

失败时：若提示「分支已存在」或「目录已存在」，**不要自行删除**，停下汇报——可能是上次中途失败留下的，需要人确认。若是「已在台账里」，直接跳到 Step 2 继续（重复执行无害）。

---

## Step 2 · 先看计划，不花钱

```bash
cd "$REPO"
pnpm exp run "$SLUG" --dry-run
```

**它在做什么**：跑**完整的前置校验**，但不执行任何命令、不写产物、不登记。校验项包括：实验未被 close、未被写成 `ship`/`no-ship` 决策、实例文件存在、两个 worktree 存在且 `git status` 干净、base 的 HEAD 等于台账的 `baseCommit`、head 的历史包含 `baseCommit`。

**判据**：

- 退出码 0；
- 输出包含两段 `cd ... pnpm bench swebench --suite lite10 --instances-file ... --repeat 1 --output .../base`（和 `head`）；
- 最后一行是 `[dry-run] 不会执行任何命令，也不会登记`。

**若报「有未提交的改动」**：说明 worktree 脏，跑批时 `manifest.git.dirty` 会是 true，登记会被拒绝。停下汇报，附 `git -C .worktrees/$SLUG status --porcelain` 的输出，**不要自行 commit 或 checkout**。

**若报「基线 worktree 的 HEAD 是 X，台账锁定的是 Y」**：基线漂移。停下汇报，**不要改台账**。

---

## Step 3 · 装依赖并确认干净

```bash
cd "$REPO"
for d in ".worktrees/$SLUG" ".worktrees/$SLUG-base"; do
  echo "--- install in $d ---"
  ( cd "$d" && pnpm install --prefer-offline ) || echo "INSTALL FAILED: $d"
done
```

**为什么两个都要装**：`node_modules` 不在 git 里，worktree 之间不共享。
安装会改动 worktree 里的 `node_modules/`（已 gitignore），**不影响** git 清洁判断，这是正常的。

```bash
git -C ".worktrees/$SLUG" status --porcelain
git -C ".worktrees/$SLUG-base" status --porcelain
```

**判据**：两条命令**都无输出**。有输出就停下汇报（贴出输出），不要提交、不要 stash。

---

## Step 4 · 真跑（唯一花钱的步骤）

### 4.1 启动

前台执行（推荐，便于观察）：

```bash
cd "$REPO"
pnpm exp run "$SLUG" --skip-install \
  --eval-mode remote --eval-host "$HOST"
```

**若执行工具的调用超时上限小于 3 小时**，改用后台执行 + 轮询：

```bash
cd "$REPO"
mkdir -p benchmark-runs/experiments
nohup pnpm exp run "$SLUG" --skip-install \
  --eval-mode remote --eval-host "$HOST" \
  > "benchmark-runs/experiments/$SLUG-run.out" 2>&1 &
echo $! > /tmp/manual-smoke.pid
cat /tmp/manual-smoke.pid
```

轮询（每次间隔 5–10 分钟，不要空转）：

```bash
cd "$REPO"
ps -p "$(cat /tmp/manual-smoke.pid)" >/dev/null 2>&1 && echo "RUNNING" || echo "EXITED"
tail -5 "benchmark-runs/experiments/$SLUG-run.out" 2>/dev/null
tail -5 "benchmark-runs/experiments/$SLUG/base/exp-run.log" 2>/dev/null
tail -5 "benchmark-runs/experiments/$SLUG/head/exp-run.log" 2>/dev/null
```

**它在做什么**：按 base → head 顺序，在每个 worktree 里执行
`pnpm bench swebench --suite lite10 --instances-file <绝对路径> --repeat 1 --output <绝对路径> --eval-mode remote --eval-host macmini-tailscale`，
子进程输出同时进控制台和 `<runDir>/exp-run.log`。两轮都成功后自动登记（跑的就是 `pnpm exp record` 的同一套校验），两轮齐了直接算对比结论。

**进度预期**：每个变体 10 题，控制台会出现 `[1/10]` … `[10/10]` 行，之后是官方 harness 评测（Docker，在远端跑），最后打印 `[base] 跑批完成 -> ...`。

### 4.2 失败处理（重要）

- **失败即停且不登记**。修好后**重跑同一条命令**即可：已完成的变体跳过，未完成的自动加 `--resume` 续跑。
- **绝对不要加 `--force`**。它会丢弃已有产物。
- 失败时先看日志尾部：`tail -50 benchmark-runs/experiments/manual-smoke/<变体>/exp-run.log`。
- 常见两类：
  - **agent 阶段失败**（模型报错、额度不足、超时）：日志里会有 `error=`；重跑即可续。
  - **harness 阶段失败**（`docker` 找不到、远端连接断）：先重跑 0.2 的探针，确认远端环境，再重跑 Step 4。

**判据**：退出码 0，且输出末行为 `登记完成：pnpm exp show manual-smoke`。

> 注意：输出里出现 `warning: 只有 1 次尝试：没有误差棒，对比只能给 inconclusive` 是**预期的**，不是失败。
> 出现 `warning: manifest 取不到 git 状态` 则需要汇报（远端/环境异常）。

---

## Step 5 · 检查产物

```bash
cd "$REPO"
pnpm exp show "$SLUG"
```

```bash
cd "$REPO" && python3 - <<'PY'
import json, pathlib
root = pathlib.Path("benchmark-runs/experiments/manual-smoke")
rows = []
for variant in ("base", "head"):
    d = root / variant
    if not (d / "report.json").exists():
        print(f"[{variant}] MISSING report.json in {d}")
        continue
    r = json.loads((d / "report.json").read_text())
    m = r["manifest"]
    tel = r.get("telemetry") or {}
    rows.append((
        variant,
        m["status"],
        m["agent"]["git"].get("dirty"),
        m.get("repeat"),
        m["selection"].get("idsHash", "")[:12],
        r["total"],
        r["passed"],
        round(r["passRate"], 4),
        r.get("resolvedInstances"),
        tel.get("dropped"),
    ))
print(f"{'variant':8}{'status':12}{'dirty':7}{'repeat':7}{'idsHash':14}{'total':6}{'passed':7}{'rate':8}{'resolved':9}{'dropped'}")
for row in rows:
    print("".join(str(x).ljust(w) for x, w in zip(row, (8, 12, 7, 7, 14, 6, 7, 8, 9, 9))))
PY
```

**判据（全部满足才算通过）**：

| 项 | 期望 |
|---|---|
| 两个变体的 `manifest.status` | `completed` |
| `agent.git.dirty` | `false` |
| `manifest.repeat` | `1` |
| 两轮 `selection.idsHash` | **完全相同** |
| `total` | `10` |
| `telemetry.dropped` | `0` |
| `exp show` 里 `runs` | 两条（base 与 head） |

任一项不符就停下汇报，附上上面脚本的完整输出和 `pnpm exp show` 的输出。

---

## Step 6 · 回读远端遥测并对账

**先检查凭据是否已存在，不要凭空猜密码**：

```bash
if [ -n "${HOTPOT_TELEMETRY_ADMIN_PASSWORD:-}" ]; then echo "CREDENTIAL: PRESENT"; else echo "CREDENTIAL: MISSING"; fi
```

- 输出 `MISSING`：**跳过 Step 6**，在最终汇报里明确写「Step 6 因缺少 `HOTPOT_TELEMETRY_ADMIN_PASSWORD` 未执行」。不要尝试登录网页后台或猜测密码。
- 输出 `PRESENT`：继续执行下面的命令。

```bash
cd "$REPO"
pnpm exp pull "$SLUG"
```

**它在做什么**：用密码 `POST /api/v1/login` 换 `hp_admin` cookie（只存内存，不落盘），按台账里的 `runId` 拉远端数据，与本地 `report.json` 逐项对账：题数、尝试数、通过次数、通过率（容差 0.5%）、`resolvedInstances`、`flakyInstances`，以及 flaky 题的**集合**是否一致。表里每格是 `本地/远端`。

**判据**：两行状态都是 `ok`，退出码 0，末行 `结论：远端与本地报告一致，远端数据可以作为决策依据。`

**异常处理**：

| 现象 | 含义 | 动作 |
|---|---|---|
| `missing` | 远端查不到这个 runId | 先看 `telemetry.dropped`；再尝试 `--from <ISO> --to <ISO>` 放宽窗口（窗口取跑批开始前 1 小时到当前） |
| `mismatch` | 数字对不上 | **停下汇报**，贴出差异行；这是上报丢事件，不要用远端数据推翻本地结论 |
| `invalid_response` | 服务端响应结构不对（多半是 v3 未部署） | 停下汇报该错误原文，不要重试刷屏 |

注意：`pull` 以退出码 1 表示「对账不一致」，**不是命令执行失败**。

---

## Step 7 · 写决策并回收

```bash
cd "$REPO"
pnpm exp decide "$SLUG" --verdict inconclusive \
  --note "手动验收：链路跑通；单次尝试无误差棒，不构成方向结论"
```

**判据**：输出包含 `决策：inconclusive` 与理由。

```bash
cd "$REPO"
pnpm exp close "$SLUG"
```

**它在做什么**：回收两个 worktree 目录，**保留分支 `exp/manual-smoke` 与台账记录**，状态置 `closed`。worktree 有未提交改动时会拒绝（此时停下汇报，**不要**自行加 `--force`，更不要手动删目录）。

**判据**：

```bash
cd "$REPO"
git worktree list | grep -c "manual-smoke" || true      # 期望 0
git branch --list "exp/$SLUG"                          # 期望仍有输出（分支保留）
pnpm exp show "$SLUG" | tail -12
```

`exp show` 应显示状态 `closed`，且决策与远端对账摘要都还在。

---

## 汇报格式

执行结束后，用下面这个结构汇报（中文）：

```
结论：成功 / 部分成功 / 失败

Step 0  预检：doctor 退出码 ?，fail 项 ?，远端探针输出 ?
Step 1  建实验：worktree ? 个，baseCommit ?
Step 2  dry-run：? 段命令，是否符合预期
Step 3  依赖：两个 worktree install ?，git status 是否为空
Step 4  跑批：base ? 分钟 / ? 通过，head ? 分钟 / ? 通过，是否触发续跑
Step 5  产物：status / dirty / repeat / idsHash 是否一致 / total / dropped
Step 6  对账：已执行 / 已跳过（原因），两轮状态 ok|missing|mismatch
Step 7  决策与回收：verdict，worktree 是否已删，分支是否保留

异常与日志路径：
- （每条失败命令的原文错误 + 对应日志文件绝对路径）

未决问题：
- （需要人决定的事，不要自己决定）
```

**汇报纪律**：

- 贴**原始输出**，不要转述成「大致成功」。
- 任何跳过（尤其 Step 6）都要写清原因。
- 失败时给出「重跑哪一条命令即可」的具体建议，不要给泛泛的诊断。
