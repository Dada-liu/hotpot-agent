# src/plan/

complex 任务的 plan 审批与修订循环（human-in-the-loop）。

- `runPlanPhase(...)`：优先复用初始轮 main 产出的计划；只有计划缺失、或 plan 开始时 next-step 队列非空时才追加一轮内部起草。
- 每轮：整理 plan → yield `plan(drafted)`（携带作为计划落盘的 assistant 消息 id，供 web 隐藏正文气泡）→ `await onPlanApproval`（缺省 fail-closed 拒绝）→ 分流：
  - `approve`：落盘 asked/decided(approved)，翻转 `planApproved`/phase，追加执行 kickoff `internal_msg` 后返回。
  - `annotate`：修订轮次 +1；超过 `planMaxRevisions`（默认 3）时 yield `revision_exhausted` 并结束；否则落盘 asked/decided(denied, note=批注)，带批注进入下一轮。
  - `reject`：落盘 asked/decided(denied, note=拒绝理由)，yield denied，追加拒绝提示并跑一轮收尾 `runTurn`。
- plan 阶段不注册工具；内部提示写 `internal_msg`（进模型历史、UI 不渲染）。
- `index.ts` 是本特性的对外出口。
