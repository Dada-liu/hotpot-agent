# Working in src/mcp/

- One failing server must never block assembly: wrap each connect in try/catch, warn and skip on failure.
- Tool naming is fixed: `mcp__<server>__<tool>`. Sanitize illegal server-name characters to `_` and warn; never silently rename tools in a way that hides collisions.
- Keep connection and tool-call timeouts (`MCP_CONNECT_TIMEOUT_MS` 30s, `MCP_TOOL_TIMEOUT_MS` 60s) and race them against the abort signal.
- `bridgeMcpTools` must pass the MCP `isError` flag through and keep `isConcurrencySafe: false`.
- The client factory is injectable for hermetic tests; tests must not spawn real servers.
- Tools from this module go only into worker/task registries; main stays meta-tools-only.
- `closeMcpConnections` must close every transport (stdio child processes included).
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
