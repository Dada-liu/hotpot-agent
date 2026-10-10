# Working in src/approval/

- `ApprovalChain.ask` is fail-closed: if every handler returns "next" (or none are registered), the decision is "deny". This is a safety-critical path — keep test coverage for both empty-chain and all-next cases.
- Handlers run sequentially in registration order; the first "allow"/"deny" short-circuits. Do not add parallelism.
- This directory implements only the chain. Emitting `approval/asked` / `approval/decided` session events is the caller's job (see `src/session/events.ts`).
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
