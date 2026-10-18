# Working in src/testing/

- Test-support utilities shipped with the package source so downstream packages (`core`, `cli`) can reuse them in their own test suites (controller Ruling 3).
- `scripted-adapter.ts` exports `scriptedAdapter(script: StreamEvent[][]): LlmAdapter`. Each array element is the exact `StreamEvent` sequence replayed by one `streamChat` call, consumed in call order; calling beyond the script length throws `script exhausted` inside the returned iterable (async rejection, matching how real adapters fail).
- `record-replay.ts` exports `createRecordingAdapter(inner, file)` and `createReplayAdapter(file)`. Recording writes one JSON line per fully consumed `streamChat` call: `{ request: ChatRequest, events: StreamEvent[] }`. Replay consumes lines in call order and throws `replay adapter exhausted` inside the iterable when the cursor runs past the end. Keep recordings local and hermetic; never commit a recording containing real user prompts or replies. Do not import `@hotpot/core` here.
- No network, no filesystem, no extra dependencies; import types from `../types.ts` only.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
