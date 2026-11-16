# Working in src/runtime/

- Agent ids are per-role monotonic and never reused within a runtime: `worker-1`, `task-1`, etc.
- Seed counters once from existing `agent_spawn` events before the first spawn (resume safety). Seeding must tolerate a missing or corrupt session file and fall back to zero.
- Serialize the seed → allocate → persist sequence through a promise chain while keeping `spawn` call-order numbering. Task turns may still run in parallel.
- `spawn` allocates an id and persists one `agent_spawn`; it never runs a turn.
- `resolveModel` delegates to `models/`; do not duplicate provider mapping here.
- Pass optional M4 fields (`home`, `features`, `compaction`, `skills`, `mcpTools`, `webSearch`/`webSearchBackend`, `hooks`, `codeSearch`) through unchanged; consumers decide gating. `home` is the explicit user-level root for MEMORY.md reads and `memory_save` writes. `codeSearch` is a lazy `CodeIndexService` injected only by upper assembly with vector enabled and complete embedding settings.
- `permissionMode: { mode: PermissionMode }` is a mutable holder on the runtime (M1): initialized from settings at assembly (default `ask-on-dangerous`) and rewritten at runtime by the server API (M2). Assembly layers must pass the same holder object to `createPermissionModeDecorator` so the decorator's execute-time dispatch and the API see one shared state.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
