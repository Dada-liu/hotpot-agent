# packages/core/src/

`@hotpot/core` 的源码目录。本包是 agent 内核，不依赖任何 UI；会话 JSONL 事件日志是唯一事实源，UI 状态全部由 `deriveMessages` 推导。

- `session/`：append-only JSONL 事件日志（`SessionEvent` 类型、`loadSession`/`createSession`/`resumeSession`、`deriveMessages` 折叠历史；加载跳过末尾损坏行）。
- `prompt/`：系统提示词 section 注册表（按 order 拼接，prompt 文案全英文；`registerDefaultSections` 非幂等，有模块级守卫）。
- `tools/`：工具框架（`ToolDefinition`/`ToolRegistry`，zod 校验擦除层）与 bash、read、write、edit 四个基础工具；高危命令与覆盖写走审批。
- `approval/`：审批 waterfall `ApprovalChain`，顺序询问，全部 next 时默认 deny（fail-closed）。
- `agent/`：turn/step 两级循环 `runTurn`；含 max_tokens 截断防御、finish=error 不执行工具、abort 补落 tool_result 等语义。
- `config.ts`：`loadSettings` 加载 `<home>/settings.json`（zod 校验，apiKey 支持 `$ENV` 引用）；home 解析复用 `session/store.ts` 的 `resolveHome`。
- `index.ts`：包入口，仅 re-export，不写逻辑。
- `node-builtins.d.ts`：node builtins 的最小 ambient 声明（依赖白名单不允许 `@types/node`），用到新 API 时在此补充。
