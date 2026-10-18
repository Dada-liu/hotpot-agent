# src/inbox/

steer/queue 双队列：next-turn（followup，turn 结束后消费）与 next-step（steer/inject，step 顶部经 `LoopConfig.pollInbox` 注入）。

- `createInbox(session, agentId, opts?)` 返回 `Inbox`：
  - `followup(content)`：next-turn 入队（FIFO）。
  - `steer(content)`：next-step 入队并唤醒。
  - `inject(content)`：next-step 入队不唤醒。
  - `cancel()`：调用 `opts.onCancel`（CLI 侧接 AbortController）。
  - `drainNextTurn()` / `pollNextStep()`：取出并清空对应队列。
  - `snapshot()`：两队列只读快照，不改变队列、不落盘。
- 每次变更先更新内存队列，再 append 一条 `inbox/spliced`（queue + 该队列全量快照）。
- `foldInbox(events)` 是纯函数、无 IO，按事件顺序重建 `InboxState`；`createInbox({ seed })` 直接消费它播种，不追加新快照。
- `index.ts` 是本特性的对外出口。
