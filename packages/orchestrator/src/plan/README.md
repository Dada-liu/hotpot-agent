# src/plan/

complex 任务的 plan 审批与修订循环（human-in-the-loop）。

- `runPlanPhase(...)`：优先复用初始轮 main 产出的计划（带 `# Plan` 标记与 Steps/Files/Acceptance criteria 三个必备段落，由 `detectPlanDraft` 校验；同轮取最新一条带标记的消息）；只有计划缺失、或 plan 开始时 next-step 队列非空时才追加一轮内部起草。
- `detectPlanDraft(...)`：首轮流路由与 spawn_workers 门禁共用的计划检测（扫描窗口 = 最后一条 main `user_msg` 之后）。漏标/缺段落一律视为普通回答。
- 每轮：整理 plan → yield `plan(drafted)`（携带作为计划落盘的 assistant 消息 id，供 web 隐藏正文气泡）→ `await onPlanApproval`（默认 fail-closed 拒绝）→ 分流：
  - `approve`：落盘 asked/decided(approved)，翻转 `planApproved`/phase，追加执行 kickoff `internal_msg` 后返回。
  - `annotate`：修订轮次 +1；超过 `planMaxRevisions`（默认 3）时 yield `revision_exhausted` 并结束；否则落盘 asked/decided(denied, note=批注)，带批注进入下一轮。
  - `reject`：落盘 asked/decided(denied, note=拒绝理由)，yield denied，追加拒绝提示并跑一轮收尾 `runTurn`。
- plan 阶段不注册工具；内部提示写 `internal_msg`（进模型历史、UI 不渲染）。
- `index.ts` 是本特性的对外出口。
