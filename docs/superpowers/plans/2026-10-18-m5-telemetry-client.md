# M5 Telemetry Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@hotpot/telemetry`, wire it into the CLI and server, and emit anonymous usage metrics plus sanitized system errors to the central service without ever blocking a turn.

**Architecture:** A new workspace package owns the event schema, sanitizer, install ID, HTTP batching client, and a collector that folds the session JSONL after each turn. The CLI and server create one runtime per process, hand each turn to a collector, enqueue the resulting events, and flush fire-and-forget. Settings are user-level only; no content, paths, prompts, or tool args leave the machine.

**Tech Stack:** Node 22, TypeScript erasable syntax, zod v4, vitest, global `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-18-m5-telemetry-benchmarks-design.md`

## Global Constraints

- Node >= 22; erasable TypeScript only; `.ts` extension on relative imports; no `any`; no inline imports.
- Comments and `README.md` in Simplified Chinese; `AGENTS.md` in English.
- `@hotpot/telemetry` may depend on `@hotpot/core` and `zod`; it must never be imported by `core` or `orchestrator`.
- Telemetry fields are a strict whitelist. Never include prompt text, replies, tool input/output, file contents, file paths, commands, repository names, or task titles.
- Telemetry must never block or fail a turn: missing endpoint, missing token, fetch rejection, timeout, and invalid settings all degrade to no-op.
- `telemetry` settings are user-level only; project-level settings must strip them.
- Run `pnpm test` and `pnpm exec biome check` from the repo root before each commit.

## Review Focus

- The endpoint is unreachable or hangs: the turn still completes and the process exits without waiting indefinitely.
- The endpoint is empty or telemetry is disabled: no request is made and no install ID is created unnecessarily.
- A path, URL, email, or 10 KB error string reaches the sanitizer: no raw path/user data survives and the result is capped at 500 chars.
- A worker/task fails while main recovers: the turn can still be `success`, while the error and tool failure are visible in metrics.
- Two turns finish close together: events are not lost or double-counted; flush is serialized per client.

---

### Task 1: Package skeleton and event schema

**Files:**
- Create: `packages/telemetry/package.json`
- Create: `packages/telemetry/tsconfig.json`
- Create: `packages/telemetry/src/node-builtins.d.ts`
- Create: `packages/telemetry/src/events.ts`
- Create: `packages/telemetry/src/index.ts`
- Create: `packages/telemetry/test/events.test.ts`

**Interfaces:**
- Produces: `telemetryBatchSchema`, `TelemetryBatch`, `TelemetryEvent`, and the event union used by every later task.
- Produces: `SCHEMA_VERSION = 1`.

- [ ] **Step 1: Write the failing schema test**

Create `packages/telemetry/test/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { telemetryBatchSchema } from "../src/events.ts";

const base = {
	schemaVersion: 1 as const,
	kind: "user" as const,
	appVersion: "0.0.0",
	installId: "00000000-0000-4000-8000-000000000000",
	events: [],
};

describe("telemetryBatchSchema", () => {
	it("accepts a minimal batch", () => {
		expect(telemetryBatchSchema.parse(base)).toEqual(base);
	});

	it("rejects unknown envelope fields", () => {
		expect(() => telemetryBatchSchema.parse({ ...base, extra: 1 })).toThrow();
	});

	it("rejects an unknown event type", () => {
		expect(() =>
			telemetryBatchSchema.parse({
				...base,
				events: [{ eventId: "e1", ts: "2026-01-01T00:00:00.000Z", type: "nope" }],
			}),
		).toThrow();
	});

	it("rejects more than 500 events", () => {
		expect(() =>
			telemetryBatchSchema.parse({
				...base,
				events: Array.from({ length: 501 }, (_, i) => ({
					eventId: `e${i}`,
					ts: "2026-01-01T00:00:00.000Z",
					type: "session_end",
					sessionId: "s",
					durationMs: 1,
					turns: 0,
					errors: 0,
				})),
			}),
		).toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/events.test.ts`
Expected: FAIL because the package and module do not exist.

- [ ] **Step 3: Create the package and schema**

`packages/telemetry/package.json`:

```json
{
	"name": "@hotpot/telemetry",
	"version": "0.0.0",
	"private": true,
	"type": "module",
	"exports": { ".": "./src/index.ts" },
	"dependencies": { "@hotpot/core": "workspace:*", "zod": "^4" }
}
```

`packages/telemetry/tsconfig.json` extends `../../tsconfig.base.json`, includes `src` and `test`, and adds `"lib": ["es2023", "dom"]` so `fetch` and `setInterval` are typed. `src/node-builtins.d.ts` declares the minimal Node APIs used here: `node:fs` (`existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`), `node:path` (`join`), `node:crypto` (`randomUUID`), and `process.env`.

In `src/events.ts`, define `SCHEMA_VERSION = 1`, `TelemetryKind = "user" | "benchmark"`, `TurnOutcome = "success" | "error" | "aborted"`, `AgentRole = "main" | "worker" | "task"`, the nine event interfaces from the spec (session_start/end, turn_start/end, llm_call, tool_call, error, feature_usage, benchmark_run), each with `eventId: string` and `ts: string`, and a discriminated `telemetryEventSchema` built with `z.discriminatedUnion("type", [...])`. Use `.strict()` on every object. The envelope is `z.object({ schemaVersion: z.literal(1), kind: z.enum(["user","benchmark"]), appVersion: z.string(), installId: z.string().uuid(), events: z.array(telemetryEventSchema).max(500) }).strict()`.

`src/index.ts` re-exports `events.ts`.

- [ ] **Step 4: Run the schema test**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/events.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry
git commit -m "feat(telemetry): add package skeleton and event schema"
```

---

### Task 2: Error sanitizer

**Files:**
- Create: `packages/telemetry/src/sanitize.ts`
- Create: `packages/telemetry/test/sanitize.test.ts`

**Interfaces:**
- Produces: `sanitizeErrorMessage(message: string, opts?: { maxLength?: number }): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../src/sanitize.ts";

describe("sanitizeErrorMessage", () => {
	it("replaces absolute paths", () => {
		expect(sanitizeErrorMessage("ENOENT: open /Users/alice/project/a.ts")).toBe(
			"ENOENT: open <path>",
		);
		expect(sanitizeErrorMessage("cannot read /home/alice/a.ts")).toBe(
			"cannot read <path>",
		);
	});
	it("strips URL query and fragment", () => {
		expect(
			sanitizeErrorMessage("GET https://example.com/x?token=secret#frag failed"),
		).toBe("GET https://example.com/x failed");
	});
	it("replaces emails", () => {
		expect(sanitizeErrorMessage("contact a@b.com")).toBe("contact <email>");
	});
	it("removes code blocks", () => {
		expect(sanitizeErrorMessage("boom\n```ts\nsecret()\n```")).toContain("<code>");
		expect(sanitizeErrorMessage("boom\n```ts\nsecret()\n```")).not.toContain("secret");
	});
	it("caps the message", () => {
		expect(sanitizeErrorMessage("x".repeat(600)).length).toBe(500);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/sanitize.test.ts`
Expected: FAIL because `sanitize.ts` does not exist.

- [ ] **Step 3: Implement `sanitizeErrorMessage`**

Order matters: replace fenced code blocks with `<code>`; normalize URLs by parsing with `new URL` and keeping `protocol//host/pathname`; replace email-like tokens with `<email>`; replace absolute POSIX/Windows paths with `<path>`; collapse whitespace; truncate to `opts?.maxLength ?? 500`. Never throw on malformed input.

- [ ] **Step 4: Run the sanitizer tests**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/sanitize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/sanitize.ts packages/telemetry/test/sanitize.test.ts
git commit -m "feat(telemetry): sanitize error messages"
```

---

### Task 3: Install ID

**Files:**
- Create: `packages/telemetry/src/install-id.ts`
- Create: `packages/telemetry/test/install-id.test.ts`

**Interfaces:**
- Produces: `loadOrCreateInstallId(opts: { home?: string; kind?: TelemetryKind }): string`. Synchronous on purpose: `createSessionManager` is synchronous, and this is a tiny local file.
- Consumes: `resolveHome` from `@hotpot/core`.

- [ ] **Step 1: Write the failing tests**

Use a temp dir for `home`; call twice and assert equality; assert a UUID shape; assert `kind: "benchmark"` produces a different file and ID.

```ts
const home = await mkdtemp(join(tmpdir(), "hotpot-telemetry-"));
const first = loadOrCreateInstallId({ home, kind: "user" });
const second = loadOrCreateInstallId({ home, kind: "user" });
expect(second).toBe(first);
expect(first).toMatch(/^[0-9a-f-]{36}$/);
const benchmark = loadOrCreateInstallId({ home, kind: "benchmark" });
expect(benchmark).not.toBe(first);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/install-id.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the install ID**

Path: `<resolveHome(home)>/telemetry/install-id` for `kind: "user"`; `<home>/telemetry/benchmark-install-id` for `kind: "benchmark"`. Create the directory recursively, read the file, validate with a UUID regex, regenerate with `randomUUID()` if missing or invalid, write it back. Keep the function idempotent.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/install-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/install-id.ts packages/telemetry/test/install-id.test.ts
git commit -m "feat(telemetry): persist anonymous install id"
```

---

### Task 4: Batching HTTP client

**Files:**
- Create: `packages/telemetry/src/client.ts`
- Create: `packages/telemetry/src/defaults.ts`
- Create: `packages/telemetry/test/client.test.ts`

**Interfaces:**
- Produces: `createTelemetryClient(opts: TelemetryClientOptions): TelemetryClient`.
- Produces: `TelemetryClient` with `enqueue`, `flush`, `close`, `stats`.
- Produces: `DEFAULT_TELEMETRY_ENDPOINT = ""` and `APP_VERSION = "0.0.0"` in `defaults.ts`.

- [ ] **Step 1: Write the failing tests**

Cover: (a) three enqueued events produce one POST with the envelope; (b) a fetch rejection is retried and eventually succeeds; (c) `enabled: false` or empty endpoint makes no request; (d) queue overflow drops the oldest and increments `stats().dropped`; (e) a hanging fetch is aborted by the timeout and does not reject `flush`.

Use a fake `fetchImpl` that records bodies and returns `new Response("{}", { status: 200 })`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the client**

- `enqueue(event)`: no-op when disabled; push; drop oldest over `maxQueue` (default 1000); trigger `void flush()` when `queue.length >= maxBatch` (default 50).
- `flush()`: serialize with a `flushing` promise; take up to `maxBatch`; POST to `${endpoint}/api/v1/ingest` with `content-type: application/json` and `authorization: Bearer <token>` when a token exists; body is `{ schemaVersion: 1, kind, appVersion, installId, events }`.
- Retry up to 3 times with 1s/2s/4s backoff; on final failure put the batch back at the front of the queue; never throw.
- `timeoutMs` default 5000; use `AbortSignal.timeout`.
- `close()`: clear the interval, flush once, mark closed.
- Default scheduler uses `setInterval`; accept `schedule` injection for tests.

- [ ] **Step 4: Run the client tests**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/client.ts packages/telemetry/src/defaults.ts packages/telemetry/test/client.test.ts
git commit -m "feat(telemetry): add async batching client"
```

---

### Task 5: Turn collector

**Files:**
- Create: `packages/telemetry/src/collector.ts`
- Create: `packages/telemetry/test/collector.test.ts`

**Interfaces:**
- Produces: `createTelemetryCollector(opts: { session: Session; sessionId: string; turnId: string; appVersion: string; features?: Settings["features"]; now?: () => number }): TelemetryCollector`.
- Produces: `TelemetryCollector.start(): TelemetryEvent`, `observe(event: ObservedOrchestrationEvent): void`, `finish(opts?: { aborted?: boolean; planRejected?: boolean }): Promise<TelemetryEvent[]>`.
- Produces: `ObservedOrchestrationEvent = { type: string; stopReason?: string; error?: { code: string; message: string }; phase?: string; role?: string }`. `observe` narrows on `type` and ignores other variants; the CLI/server can pass their full event union. This keeps `@hotpot/telemetry` free of an orchestrator dependency.
- Produces: `sessionStartEvent(opts: { sessionId: string; resumed: boolean; appVersion: string; features?: Settings["features"] }): SessionStartEvent`.
- Produces: `sessionEndEvent(opts: { sessionId: string; startedAt: number; turns: number; errors: number; now?: () => number }): SessionEndEvent`.
- Consumes: `loadSession` from `@hotpot/core`; `OrchestrationEvent` from `@hotpot/orchestrator` is not a dependency — import the type from `@hotpot/core`? `OrchestrationEvent` lives in orchestrator. To avoid a dependency cycle, define a minimal structural type in `collector.ts` for the observed fields (`type`, `stopReason`, `error.code`, `error.message`, `phase`, `role`) and accept `unknown` at the boundary. The CLI/server pass their event objects; TypeScript structural typing works.

- [ ] **Step 1: Write the failing tests**

Create a temp home and session with `createSession`, then append a fixture turn:

```ts
await session.append({ type: "user_msg", id: "u1", ts: "2026-01-01T00:00:00.000Z", agentId: "main", content: "fix it" });
await session.append({ type: "assistant_msg", id: "a1", ts: "2026-01-01T00:00:01.000Z", agentId: "main", content: [{ type: "tool_call", id: "c1", name: "bash", input: { command: "echo secret" } }], usage: { input: 10, output: 5 }, model: "m", tier: "high" });
await session.append({ type: "tool_result", id: "r1", ts: "2026-01-01T00:00:02.000Z", agentId: "main", toolCallId: "c1", content: "secret output", isError: false });
await session.append({ type: "assistant_msg", id: "a2", ts: "2026-01-01T00:00:03.000Z", agentId: "worker-1", content: [], usage: { input: 7, output: 3 }, model: "m", tier: "medium" });
await session.append({ type: "error", id: "e1", ts: "2026-01-01T00:00:04.000Z", agentId: "worker-1", code: "E_TEST", message: "failed at /Users/a/x" });
```

Create the collector with `turnId: "t1"`, call `start()`, `observe({ type: "done", stopReason: "stop" })`, then `finish()`. Assert:
- one `turn_start`;
- one `turn_end` with `inputTokens: 17`, `outputTokens: 8`, `assistantMessages: 2`, `mainSteps: 1`, `byTier.high.input: 10`, `byTier.medium.input: 7`;
- two `llm_call` events;
- one `tool_call` with `toolName: "bash"`, `durationApprox: true`, `durationMs: 1000`, `agentRole: "main"`;
- one `error` with `sanitizedMessage` not containing `/Users/a/x`;
- no event contains the string `secret`.
Also test outcomes: `done(stop)` + no errors => success; any error => error; `aborted: true` => aborted; plan `denied` + `planRejected` => aborted; `revision_exhausted` => error.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/collector.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the collector**

At creation, capture `startTs = new Date(now()).toISOString()`. `start()` returns a `turn_start` event with a generated `eventId` and `ts`. `observe` records the latest `done.stopReason`, any `error` payload, plan phases, and spawn roles. `finish` loads the session JSONL, filters events with `ts >= startTs`, and folds:
- `assistant_msg`: one `llm_call` each; aggregate totals/byTier/byModel; count main steps and assistant messages.
- `tool_result`: match `toolCallId` to the tool_call block in the latest preceding `assistant_msg`; duration = result ts minus that message ts; `agentRole` from the agentId prefix; `isError` from the result.
- `error`: one sanitized `error` event.
- `agent_spawn`: count worker/task.
- `feature_usage`: count feature events and tool names (todo, web_search, web_fetch, mcp__, hooks, skills, promptTemplates).
Outcome precedence: aborted > error > success. Include `turn_end` last. Never include `content`, `input`, or `message` raw text; only `sanitizedMessage`.

- [ ] **Step 4: Run the collector tests**

Run: `pnpm --filter @hotpot/telemetry exec vitest run test/collector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/src/collector.ts packages/telemetry/test/collector.test.ts
git commit -m "feat(telemetry): fold turns into anonymous metrics"
```

---

### Task 6: Settings schema

**Files:**
- Modify: `packages/core/src/config/config.ts`
- Modify: `packages/core/test/config.test.ts`

**Interfaces:**
- Produces: `Settings["telemetry"]` with `enabled?: boolean`, `endpoint?: string`, `token?: string`, `flushIntervalMs?: number`.
- Produces: `TelemetryConfig` type export.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/config.test.ts`: a user-level settings object with `telemetry` parses; a project-level `.hotpot/settings.json` containing `telemetry` is stripped from the merged result.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/core exec vitest run test/config.test.ts`
Expected: FAIL because the schema has no `telemetry` field.

- [ ] **Step 3: Add the schema**

Add `telemetrySchema` to `config.ts` with the four optional fields; add `telemetry: telemetrySchema.optional()` to `settingsSchema` only (never `projectSettingsSchema`); export `TelemetryConfig`. Keep credentials resolution unchanged; the telemetry token supports `$ENV` in the runtime helper (Task 7), not in the schema.

- [ ] **Step 4: Run the config tests**

Run: `pnpm --filter @hotpot/core exec vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): add user-level telemetry settings"
```

---

### Task 7: Runtime helper and CLI integration

**Files:**
- Create: `packages/telemetry/src/runtime.ts`
- Modify: `packages/telemetry/src/index.ts`
- Modify: `packages/cli/src/chat.ts`
- Modify: `packages/cli/package.json`
- Create: `packages/cli/test/telemetry.test.ts`

**Interfaces:**
- Produces: `createTelemetryRuntime(settings, opts): Promise<TelemetryRuntime | null>`.
- `TelemetryRuntime` = `{ client: TelemetryClient; createCollector(session: Session, opts: { turnId: string; features?: Settings["features"] }): TelemetryCollector }`.
- Adds `telemetryFetch?: typeof fetch` to `RunChatOptions` for tests.
- Endpoint resolution: `settings.telemetry?.endpoint ?? process.env.HOTPOT_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT`; token supports a whole-string `$NAME` env reference; missing token is not fatal (request without auth).

- [ ] **Step 1: Write the failing CLI test**

Create a `runChat` test with a temp home, a scripted adapter returning one text round, a fake `telemetryFetch` that captures the body, and a scripted input. Assert after the turn:
- the captured body parses with `telemetryBatchSchema`;
- `kind === "user"`;
- there is a `turn_end` with `outcome: "success"`;
- `JSON.stringify(body)` does not contain the user prompt text or the assistant text.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/cli exec vitest run test/telemetry.test.ts`
Expected: FAIL because telemetry is not wired.

- [ ] **Step 3: Implement the runtime helper and wire `runChat`**

`createTelemetryRuntime`: resolve enabled (`settings.telemetry?.enabled ?? true`), endpoint, token, flush interval (default 30000), install ID (`kind: "user"`), and return null when disabled or endpoint is empty. `createCollector` calls `createTelemetryCollector` with `sessionId: session.id`, the runtime's `appVersion`, a generated UUID turnId, and the passed `features`.

In `runChat`:
- capture `sessionStartedAt = Date.now()`, then create the runtime after `loadSettings`/session setup (respect `opts.home`);
- send `session_start` with `resumed` matching the create/resume path;
- before each `runMainTurn`, create a collector, enqueue `start()`, call `observe(event)` for every yielded event, and in `finally` enqueue `finish({ aborted: ac.signal.aborted })` then `void client.flush()`;
- on REPL exit, enqueue `session_end` with `startedAt: sessionStartedAt`, the turn count, and error count, then `await client.close()`.

Add `@hotpot/telemetry: "workspace:*"` to `packages/cli/package.json` and run `pnpm install`.

- [ ] **Step 4: Run the CLI telemetry test**

Run: `pnpm --filter @hotpot/cli exec vitest run test/telemetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry packages/cli
git commit -m "feat(cli): emit telemetry per turn"
```

---

### Task 8: Server integration

**Files:**
- Modify: `packages/server/src/session-manager.ts`
- Modify: `packages/server/package.json`
- Create: `packages/server/test/telemetry.test.ts`

**Interfaces:**
- Adds `telemetryFetch?: typeof fetch` to `SessionManagerOptions`.
- Reuses `createTelemetryRuntime` and the collector.
- `session_start` on `create` (`resumed: false`) and `attachById` (`resumed: true`); capture each session's start time (creation or attach). `session_end` for every attached session in `close()`, using that start time and the session's turn/error counts.

- [ ] **Step 1: Write the failing server test**

Use `createSessionManager` with a temp home, a scripted adapter, and a fake `telemetryFetch`; create a session, `send` a message, wait for idle, then parse the captured body. Assert `turn_end.outcome === "success"`, totals include any worker/task usage, and the body contains none of the user prompt or assistant text.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @hotpot/server exec vitest run test/telemetry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire the server**

Create the runtime in `createSessionManager`; in `runOneTurn`, create a collector, enqueue `start()`, observe every yielded event, and enqueue `finish` in the same `finally` block that resets `currentAbort`. Emit `session_start`/`session_end` at the create/attach/close points. Add the workspace dependency and run `pnpm install`.

- [ ] **Step 4: Run the server telemetry test and the full suite**

Run: `pnpm --filter @hotpot/server exec vitest run test/telemetry.test.ts`
Expected: PASS.
Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): emit telemetry per turn"
```

---

### Task 9: Docs and final verification

**Files:**
- Create: `packages/telemetry/README.md`
- Create: `packages/telemetry/AGENTS.md`
- Modify: `packages/AGENTS.md` (package list/dependency note)
- Modify: `docs/archive/02-architecture.md` (telemetry client flow)
- Modify: `docs/archive/04-roadmap.md` (M5.1 status)

- [ ] **Step 1: Write the package docs**

README covers: package purpose, event whitelist, endpoint/token resolution, disable switch, install ID location, and the "no user content" rule. AGENTS covers: strict schema, sanitizer ordering, never throw/block, user-level-only settings, and cross-feature import rules.

- [ ] **Step 2: Update repo docs**

Add `packages/telemetry` to the package list and document the flow `cli/server → collector → client → ingest`. Update the M5 roadmap status for M5.1.

- [ ] **Step 3: Run the full verification**

Run: `pnpm typecheck`
Expected: no errors.
Run: `pnpm test`
Expected: all tests pass.
Run: `pnpm exec biome check .`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/telemetry docs/archive/02-architecture.md docs/archive/04-roadmap.md packages/AGENTS.md
git commit -m "docs(telemetry): document client and M5.1 status"
```
