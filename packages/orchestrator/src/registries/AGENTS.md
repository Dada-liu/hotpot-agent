# Working in src/registries/

- Role tool sets are fixed: main has meta tools plus the plain `read` tool (M1 — its only direct file tool, registered without decoration or skill tracking); worker has the base four + feature-derived tools + meta tools; task has the base four + feature-derived tools and ignores meta tools. With `features.memory=true`, main/worker also register the undecorated `memory_save`; task never registers it. When `features.vector=true` and `runtime.codeSearch` is present, every role additionally receives the undecorated `code_search` tool.
- Derive feature tools from `runtime.features` through core's `featureEnabled` (default on except memory/vector): todo, web_fetch, web_search, MCP, memory_save, code_search. Code search requires an injected service and stays lazy; registration never scans or calls embeddings.
- `decorateWorkerTool` applies only to the worker/task base four (bash/read/write/edit); main's read, feature-derived tools, and meta tools are never decorated. Assembly layers provide it via `createPermissionModeDecorator(holder)` (runtime.ts), which dispatches dynamically at execute time on `holder.mode` (readonly pre-approves non-read tools; ask-on-dangerous/full pass through).
- `createWorkerRegistry` is the only way to give a worker its bound `spawn_tasks`; nested task splitting depends on that closure.
- Keep the read-tool skill tracking wrapper: it appends `skill/loaded` once per session per file and must stay read-only otherwise.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
