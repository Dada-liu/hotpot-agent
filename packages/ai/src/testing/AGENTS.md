# Working in src/testing/

- Test-support utilities shipped with the package source so downstream packages (`core`, `cli`) can reuse them in their own test suites (controller Ruling 3).
- `scripted-adapter.ts` exports `scriptedAdapter(script: StreamEvent[][]): LlmAdapter`. Each array element is the exact `StreamEvent` sequence replayed by one `streamChat` call, consumed in call order; calling beyond the script length throws `script exhausted` inside the returned iterable (async rejection, matching how real adapters fail).
- No network, no filesystem, no extra dependencies; import types from `../types.ts` only.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
