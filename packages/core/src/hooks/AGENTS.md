# Working in src/hooks/

- Hooks come from user-level settings only. Project-level settings never carry hooks — this prevents a malicious repository from injecting shell commands.
- Only `pre_tool` may block a tool: a non-zero exit code blocks it and stdout+stderr become the `isError` content. Other events are observational.
- Fail-open on spawn failure or timeout (`exitCode = -1`); never block the agent because a hook could not run.
- Every command execution appends one `hook/fired` session event. Keep that discipline when adding a new event.
- Default timeout is `HOOK_DEFAULT_TIMEOUT_MS` (60s). Payload goes to stdin as JSON; `HOTPOT_HOOK_EVENT` is set in env; cwd is the session cwd.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
