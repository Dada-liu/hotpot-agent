# 并发审批不丢失（pendingApprovals map + server 对账）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 并行 task agent 场景下多个工具审批同时挂起时，web 端能同时展示并可逐项裁决全部审批，且断线重连/刷新后能恢复；切换 full 模式时放行在途审批，消除「回合永挂、卡片永转」死锁。

**Architecture:** web reducer 的 `pendingApproval` 单槽位改为按 requestId 的 `pendingApprovals` map，审批 prompt 挂回各自 transcript 审计行渲染；server 在订阅补发后按 `bridge.pending()`（内存权威）经 `hub.replay` 对账合成 approval wire 事件；`applyPermissionMode` 切到 full 时 drain 在途 tool 审批。

**Tech Stack:** TypeScript（erasable syntax）、React、vitest、Hono、zod。

**Spec:** 本会话诊断结论（temp 会话 `ec98e96a`）+ `.kimi-code/skills/syncing-ui-state-events/SKILL.md`（模式 B 对账；禁止用 durable 日志重建内存权威状态）。

## Global Constraints

- 事件契约只增不改：`packages/core/src/session/events.ts` 与 `packages/web/src/protocol.ts` 本次均不改动。
- 瞬态 wire 协议 `packages/server/src/wire.ts` 不改动（approval 事件已带 requestId/summary/detail）。
- wire/散播相关新逻辑必须走 `hub.replay`（sink-only、seq 连续、不进 buffer、不广播）。
- 提交信息无 emoji；代码注释简体中文；UI 文案可中文。
- 不做向后兼容：`pendingApproval` 单槽位直接移除，不留别名。

## Review Focus

- 10 个并发审批同时到达：map 必须全部保留、逐个可答（单槽位是本次事故根源）。
- 刷新/重连：pending 审批从 `bridge.pending()` 重建，不得从 `approval/asked` 日志重建（重启后是幽灵）。
- 重复投递：wire 原事件 + 对账合成事件对同一 requestId 只渲染一个 prompt。
- `turn(end)` 兜底清空：回合结束/取消后不得残留可点 prompt（服务端已拒决）。
- AgentPanel 详情视图：审批行保持只读 Trace，不得出现可点按钮（与主对话区区分）。

---

### Task 1: web reducer 改为 pendingApprovals map

**Files:**
- Modify: `packages/web/src/state/reducer.ts`
- Test: `packages/web/test/reducer.test.ts`

**Interfaces:**
- Consumes: 现有 wire `approval` 事件（requestId/approvalType/summary/detail）、`approval/decided` 日志、`approval-answered` 本地 action。
- Produces: `ChatState.pendingApprovals: Record<string, PendingApproval>`；`applyApprovalDecided(state, {requestId, decision, note?})` 签名不变。

- [x] **Step 1: 改写现有断言并新增失败用例**

现有测试中所有 `pendingApproval` 引用改名 `pendingApprovals`。新增用例（同文件）：
```ts
it("并发 approval 事件全部保留，decided 只清对应项", () => {
  let s = createInitialState();
  s = reduce(s, { seq: 1, kind: "approval", requestId: "r1", approvalType: "tool", summary: "write a.md" });
  s = reduce(s, { seq: 2, kind: "approval", requestId: "r2", approvalType: "tool", summary: "write b.md" });
  expect(Object.keys(s.pendingApprovals)).toEqual(["r1", "r2"]);
  s = reduce(s, { seq: 3, kind: "log", event: { type: "approval/decided", id: "d1", ts: "", requestId: "r1", decision: "approved" } });
  expect(Object.keys(s.pendingApprovals)).toEqual(["r2"]);
});

it("同一 requestId 重复投递只保留一项（wire + 对账合成幂等）", () => {
  let s = createInitialState();
  const ev = { seq: 1, kind: "approval" as const, requestId: "r1", approvalType: "tool" as const, summary: "write a.md" };
  s = reduce(s, ev);
  s = reduce(s, { ...ev, seq: 2 });
  expect(Object.keys(s.pendingApprovals)).toEqual(["r1"]);
});

it("turn(end) 清空全部 pendingApprovals", () => {
  let s = createInitialState();
  s = reduce(s, { seq: 1, kind: "approval", requestId: "r1", approvalType: "tool", summary: "x" });
  s = reduce(s, { seq: 2, kind: "approval", requestId: "r2", approvalType: "tool", summary: "y" });
  s = reduce(s, { seq: 3, kind: "turn", phase: "end" });
  expect(s.pendingApprovals).toEqual({});
});
```
（`approval/decided` 日志事件的既有构造方式参考同文件已有用例，字段以 protocol.ts 为准。）

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/web/test/reducer.test.ts`
Expected: 新用例 FAIL（`pendingApprovals` 不存在）。

- [x] **Step 3: 实现**

`reducer.ts`：
- `ChatState`：`pendingApproval: PendingApproval | null` → `pendingApprovals: Record<string, PendingApproval>`；`createInitialState` 返回 `pendingApprovals: {}`。
- `applyApprovalDecided`：删除匹配 key（`const { [requestId]: _, ...rest }` 或 `Object.fromEntries(Object.entries(...).filter(...))`），transcript 回填不变；`pendingPlan` 清理逻辑改读 map（plan 不进 map，直接 `pendingPlan` 原逻辑保留）。
- `case "approval"`（tool 型）：`pendingApprovals: { ...state.pendingApprovals, [event.requestId]: {...} }`（upsert）。
- `turn(end)`：`pendingApprovals: {}`。
- `approval/asked` 重放分支保持现状（只落审计行，不恢复 pending——由 Task 2 的 server 对账负责恢复）。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/web/test/reducer.test.ts`
Expected: PASS，全部用例绿。

### Task 2: server 订阅时按 bridge.pending() 对账

**Files:**
- Modify: `packages/server/src/approvals.ts`
- Modify: `packages/server/src/session-manager.ts:1411-1494`（subscribe / subscribeResuming）
- Test: `packages/server/test/session-manager.test.ts`（可扩展 api.test.ts）

**Interfaces:**
- Consumes: `ApprovalBridge.pending()`；wire `approval` 事件形状。
- Produces: `ApprovalBridge.pendingToolAsks(): Array<{ requestId: string; summary: string; detail?: string }>`（仅 tool 型，含 notify 时的 payload）。

- [x] **Step 1: 写失败测试**

在 session-manager.test.ts 的审批用例基础上新增：bash 高危命令触发 ask（复用 `:268` 用例的驱动方式）→ 不答题、先 `subscribe(id, null, sink)` 一个新订阅者 → 断言新 sink 收到一条 `kind === "approval"` 且 `requestId` 等于原 ask 的合成事件；同时断言原事件的 requestId 与 `approval/asked` 日志 id 一致。

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/server/test/session-manager.test.ts -t "对账"`
Expected: FAIL（订阅收不到合成 approval）。

- [x] **Step 3: 实现**

`approvals.ts`：`pendingMap` 的 value 增加 `payload: ApprovalNotifyPayload`（registerToolAsk/registerPlanAsk 写入）；新增
```ts
pendingToolAsks(): Array<{ requestId: string; summary: string; detail?: string }>
```
遍历 pendingMap，仅 `type === "tool"` 的条目返回 payload 字段。

`session-manager.ts`：抽一个闭包内 helper
```ts
function replayPendingApprovals(m: ManagedSession, sink: (e: WireEvent) => void): void {
  for (const ask of m.bridge.pendingToolAsks()) {
    sink(m.hub.replay({ kind: "approval", requestId: ask.requestId, approvalType: "tool", summary: ask.summary, ...(ask.detail === undefined ? {} : { detail: ask.detail }) }));
  }
}
```
在 `subscribe` 的 catch-up 之后、`registerLive` 之前调用；`subscribeResuming` 三个路径（null 全量 / 窗口内增量 / 掉窗重放）各自在交付完 catch-up、注册 live sink 前调用。合成事件只进该订阅者 sink，不进 buffer、不广播。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/server/test/session-manager.test.ts`
Expected: PASS（含既有审批用例）。

### Task 3: web 渲染改为按审计行内联、逐项可答

**Files:**
- Modify: `packages/web/src/components/ChatView.tsx`（TranscriptItem / TurnView / ChatView 透传）
- Modify: `packages/web/src/App.tsx:498-519`（handleApproval）
- Modify: `packages/web/src/components/ApprovalPrompt.tsx`（可选：显示 requestId 短前缀，便于对账）

**Interfaces:**
- Consumes: `ChatState.pendingApprovals`（Task 1）、wire approval 事件（含 detail）。
- Produces: `TranscriptItem` 新增可选 props `pendingApprovals?: Record<string, PendingApproval>`、`onApproval?: (requestId: string, decision: "allow" | "deny") => void`、`approvalBusy?: boolean`；`App.handleApproval(requestId: string, decision: "allow" | "deny")`。

- [x] **Step 1: 实现（本任务无组件测试设施，验证靠类型检查与构建）**

- `TranscriptItem` 的 `case "approval"`：`const pending = pendingApprovals?.[entry.requestId]`；`pending !== undefined && entry.approvalType === "tool"` → 渲染 `<ApprovalPrompt summary={pending.summary} detail={pending.detail} busy={approvalBusy} onAnswer={(d) => onApproval?.(entry.requestId, d)} />`，否则保持 `<ApprovalTrace>`。
- 删除 `TurnView` 底部单条 `pendingApproval` 渲染块（`ChatView.tsx:877-888`）；`TurnView` props 由 `pendingApproval` 改为 `pendingApprovals`（透传给 `processItems`/`standingItems`/`finalEntry` 三处 `TranscriptItem`），`onApproval` 签名改为 `(requestId, decision)`。
- `ChatView` 调用处 `pendingApproval={state.pendingApproval}` 改 `pendingApprovals={state.pendingApprovals}`。
- `App.tsx` `handleApproval(requestId, decision)`：去掉对 `chat.pendingApproval` 的读取，直接 `answerApproval(currentId, requestId, decision)` + 乐观 `approval-answered`；`onApproval={(requestId, decision) => void handleApproval(requestId, decision)}`。
- AgentPanel 的 `TranscriptItem` 调用不传新 props → 详情视图自然保持只读。

- [x] **Step 2: 验证**

Run: `pnpm --filter @hotpot/web build`
Expected: 构建成功（tsc + vite 无错）。

### Task 4: 切到 full 模式时 drain 在途审批

**Files:**
- Modify: `packages/server/src/session-manager.ts`（`applyPermissionMode`，约 `:436`）
- Test: `packages/server/test/session-manager.test.ts`

**Interfaces:**
- Consumes: `ApprovalBridge.pending()` / `answer(requestId, "allow")`。
- Produces: 无新导出；`applyPermissionMode` 行为扩展。

- [x] **Step 1: 写失败测试**

新增用例：bash 高危命令触发 ask → 不答题 → `await sm.setPermission(id, "full")` → 断言 ask 的 parked promise 已放行（后续收到该 tool 的 `tool_result` 与 `log(approval/decided decision=approved)`），且 turn 能继续到 `turn(end)`。

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/server/test/session-manager.test.ts -t "drain"`
Expected: FAIL（切 full 后仍挂起）。

- [x] **Step 3: 实现**

`applyPermissionMode`：写入 holder 与落盘/广播之后，若 `mode === "full"`，对 `m.bridge.pending()` 逐个 `m.bridge.answer(requestId, "allow")`（plan 型条目由 `answer` 类型不符返回 false，忽略即可；tool 型放行后审计层自动落 `approval/decided`）。注释说明：full 语义是「永不打断」，对存量 parked 询问同样成立。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/server/test/session-manager.test.ts`
Expected: PASS。

### Task 5: 全量验证

**Files:** 无新增。

- [x] **Step 1: 全量测试与类型检查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部通过。

- [x] **Step 2: 手动验证清单**

`pnpm dev web` 后在 ask-on-dangerous 下重跑「建 10 个文件」（目标文件已存在以触发覆盖审批）：10 个 prompt 同时出现、逐个可答；答完回合正常结束、卡片全部收敛；刷新页面后未答 prompt 仍在；中途切 full 立即放行。
