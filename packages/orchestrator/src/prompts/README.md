# src/prompts/

main / worker / task 三角色系统提示词（LLM 面向文案全英文）。

- `buildRoleSystemPrompt(role, ctx, opts?)`：core 默认四段（identity/tools/rules/env）+ 角色指令段，本地组装后调用 `buildSystemPrompt(ctx, sections)`，不触碰全局 section 注册表。
- 可选动态段：skills（order 1400）、todos（order 1500）、memory（order 1600）；空列表或空记忆摘要不出段。memory 英文说明只允许保存稳定偏好/事实，禁止密钥、凭证与临时任务状态。
- 角色指令：main 职责 + 难度判定/模型路由；worker 并行拆分三条件与摘要回传；task 摘要回传。
- plan 起草/修订与执行阶段分别用 `PLANNING_INSTRUCTIONS` / `EXECUTION_INSTRUCTIONS` 覆盖角色指令段。
- `index.ts` 是本特性的对外出口。
