# src/main-turn/

`runMainTurn`：一次用户消息的主流入口（main agent）。

- 以 `"main"` 身份落盘 user_msg → main 角色注册表（delegate 元工具）跑 core `runTurn` → 透传全部事件。
- complex 流：delegate 判定后进入 `plan/` 的 `runPlanPhase`，初始轮产出的计划直接复用；批准后换用只挂 `spawn_workers` 的注册表跑执行 turn。
- worker/task 的 spawn 经包装 `runtime.spawn` 推入本回合待产队列，主循环先 drain 再透传，保证 `agent_spawn` 先于对应 tool_result 到达且与调用序一致。
- 传入 `inbox` 时，初始轮、plan 起草/修订轮与执行轮都在 step 顶部消费 next-step。
- `onPlanApproval` 缺省时 plan 阶段 fail-closed（拒绝并收尾）。
- `index.ts` 是本特性的对外出口。
