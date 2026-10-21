# src/main-turn/

`runMainTurn`：一次用户消息的主流入口（main agent）。

- 以 `"main"` 身份落盘 user_msg → main 角色注册表（只挂 spawn_workers）跑 core `runTurn` → 透传全部事件。
- 首轮提示词路由（无 delegate）：trivial 纯文本直答；simple 首轮直接 spawn_workers（本回合无计划标记即放行）；complex 不调用工具、本轮最终消息按 `PLAN_FORMAT_TEMPLATE` 输出计划正文。
- 初始 turn 结束后 `detectPlanDraft` 命中 → `state.phase="planning"`，进入 `plan/` 的 `runPlanPhase`（首轮草稿直接复用）；批准后跑执行 turn（注册表仍只挂 spawn_workers，`planApproved` 翻转后门禁放行）。未命中 → trivial/simple 已闭环，`endTurn` 收尾。
- worker 的 spawn 经包装 `runtime.spawn` 推入本回合待产队列，主循环先 drain 再透传，保证 `agent_spawn` 先于对应 tool_result 到达且与调用序一致。
- 传入 `inbox` 时，初始轮、plan 起草/修订轮与执行轮都在 step 顶部消费 next-step。
- `onPlanApproval` 默认时 plan 阶段 fail-closed（拒绝并收尾）。
- `index.ts` 是本特性的对外出口。
