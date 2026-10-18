# src/registries/

按角色装配工具注册表（规则见 `docs/archive/03-agent-orchestration.md` §1）。

- `createRoleRegistry(runtime, role, metaTools)`：
  - main：只有编排元工具，不直接操作文件。
  - worker：bash/read/write/edit + feature 派生工具 + metaTools。
  - task：bash/read/write/edit + feature 派生工具，忽略 metaTools。
- feature 派生按 `runtime.features` 判读：todo、web_fetch、web_search、MCP；`decorateWorkerTool` 只作用于四件套基础工具。
- `createWorkerRegistry(runtime, { agentId, tier })`：worker 专用工厂，闭包绑定该 worker 的 `spawn_tasks`，派生 task 继承其档位。
- read 工具包一层 skill 追踪，命中 `SKILL.md` 时落 `skill/loaded`（每会话每文件一次）。
- `index.ts` 是本特性的对外出口。
