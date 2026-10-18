# M5 Telemetry Admin Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone telemetry admin service in `../hotpot-telemetry/`: ingest anonymous events, store them in SQLite, expose aggregation APIs, render a single-operator dashboard, and deliver threshold alerts via SMTP, generic webhook, and Feishu.

**Architecture:** One Node 22 process hosts a Hono API, a SQLite database, a scheduler that evaluates alert rules every 60 seconds, and a Vite-built React SPA. It is a separate project outside the pnpm workspace and is never imported or bundled by hotpot-code. The ingest API validates the strict event whitelist, deduplicates by `event_id`, and only stores metadata.

**Tech Stack:** Node 22, TypeScript, Hono, `@hono/node-server`, `better-sqlite3`, zod, nodemailer, React 18, Vite, Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-m5-telemetry-benchmarks-design.md`

## Global Constraints

- The service lives in `../hotpot-telemetry/` (sibling of the repo). It is not a workspace package and must not be added to `pnpm-workspace.yaml`.
- Node >= 22; erasable TypeScript; `.ts` extensions; no `any`; comments and README in Simplified Chinese; AGENTS in English.
- Accept only the event whitelist. Reject or drop any unknown field. Never store prompt/reply/tool input/output/file content/path/command text.
- Single operator only: one `ADMIN_PASSWORD`, one `INGEST_TOKEN`; no user accounts or teams.
- All ingest and alert delivery failures are logged; they never crash the process.
- Raw events retain 30 days by default (`RETENTION_DAYS`); daily rollups retain 365 days.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm exec biome check .` inside `../hotpot-telemetry/` before each commit.

## Review Focus

- A malicious or buggy client sends unknown fields or 500+ events: ingest rejects the batch cleanly and stores nothing outside the whitelist.
- The same `event_id` arrives twice: aggregates do not double-count.
- The database file is locked or the disk is full: the server returns a structured error and keeps serving existing data.
- SMTP/Feishu/webhook is down: alert evaluation still records firing state, retries, and a delivery failure row.
- The operator opens a range with no data: dashboards render zeros and an empty state instead of crashing.

---

### Task 1: Standalone project scaffold and health endpoint

**Files:**
- Create: `../hotpot-telemetry/package.json`
- Create: `../hotpot-telemetry/tsconfig.json`
- Create: `../hotpot-telemetry/src/server/index.ts`
- Create: `../hotpot-telemetry/src/server/app.ts`
- Create: `../hotpot-telemetry/test/health.test.ts`

**Interfaces:**
- Produces: `createApp(deps: { db: Database; config: AppConfig; now?: () => number; mail?: Mailer; fetchImpl?: typeof fetch }): Hono`.
- Produces: `AppConfig` with `port`, `dataDir`, `adminPassword`, `ingestToken`, `retentionDays`, `smtp`, `feishuWebhookUrl`.
- Produces: `openDb(path: string): Database` and `migrate(db: Database): void` (minimal in this task; Task 2 adds the full schema and retention).

- [ ] **Step 1: Write the failing health test**

```ts
import { describe, expect, it } from "vitest";
import { openDb, migrate } from "../src/db/db.ts";
import { createApp } from "../src/server/app.ts";

it("returns ok", async () => {
	const db = openDb(":memory:");
	migrate(db);
	const app = createApp({
		db,
		config: {
			port: 4580,
			dataDir: ".",
			adminPassword: "test",
			ingestToken: "test-token",
			retentionDays: 30,
		},
	});
	const res = await app.request("/healthz");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/health.test.ts`
Expected: FAIL because the project does not exist.

- [ ] **Step 3: Create the scaffold**

`package.json` scripts: `dev` (`tsx watch src/server/index.ts`), `start` (`tsx src/server/index.ts`), `test` (`vitest run`), `typecheck` (`tsc -p .`), `build:web` (`vite build`). Dependencies: `hono`, `@hono/node-server`, `better-sqlite3`, `zod`, `nodemailer`; dev: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/better-sqlite3`, `@types/nodemailer`, `vite`, `react`, `react-dom`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@types/react`, `@types/react-dom`.

`createApp` returns a Hono app with `GET /healthz → { ok: true }`. `index.ts` reads env into `AppConfig`, opens the DB, starts the server on `0.0.0.0:${PORT ?? 4580}`.

- [ ] **Step 4: Run the health test**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git init  # only if the directory is not already a repository
git add package.json tsconfig.json src/server test/health.test.ts
git commit -m "feat: scaffold telemetry admin service"
```

---

### Task 2: SQLite schema, migration, and retention

**Files:**
- Create: `../hotpot-telemetry/src/db/db.ts`
- Create: `../hotpot-telemetry/src/db/schema.sql`
- Create: `../hotpot-telemetry/src/db/migrate.ts`
- Create: `../hotpot-telemetry/test/db.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Database` (WAL enabled).
- Produces: `migrate(db: Database): void`.
- Produces: `pruneOldEvents(db: Database, now: Date): number`.

- [ ] **Step 1: Write the failing migration test**

Open `:memory:`, run `migrate`, assert the tables `telemetry_events`, `installations`, `alert_rules`, `alert_events`, `deliveries`, `admin_sessions` exist. Insert two events, call `pruneOldEvents` with a cutoff, assert only the old one is deleted.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/db.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the schema**

Create the tables from spec §7.3 with the listed columns and indexes. Use `TEXT` for ids/timestamps and `INTEGER` for counters. `telemetry_events.event_id` is the primary key. Enable `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`. `pruneOldEvents` deletes `telemetry_events` older than `RETENTION_DAYS` and keeps `alert_events`/`deliveries` for 365 days.

- [ ] **Step 4: Run the DB tests**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add src/db test/db.test.ts
git commit -m "feat: add sqlite schema and retention"
```

---

### Task 3: Ingest API with auth, validation, and idempotency

**Files:**
- Create: `../hotpot-telemetry/src/ingest/ingest.ts`
- Create: `../hotpot-telemetry/src/shared/events.ts`
- Modify: `../hotpot-telemetry/src/server/app.ts`
- Create: `../hotpot-telemetry/test/ingest.test.ts`

**Interfaces:**
- Produces: `ingestBatch(db, batch: TelemetryBatch): { accepted: number; rejected: number }`.
- Produces: `POST /api/v1/ingest` requiring `Authorization: Bearer <INGEST_TOKEN>`.
- Consumes: `telemetryBatchSchema` from `../shared/events.ts` (copy of the tool schema, strict).

- [ ] **Step 1: Write the failing tests**

Cases: valid batch accepted; wrong token → 401; unknown field → 400 and nothing stored; duplicate `event_id` → accepted once and aggregate count stays 1; more than 500 events → 400; body over 1 MB → 413.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/ingest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement ingest**

Parse JSON, enforce `content-type: application/json`, cap the body at 1 MB, validate with `telemetryBatchSchema`, insert each event with `INSERT OR IGNORE` in a transaction, and return `{ accepted, rejected }`. `telemetry_events` stores `event_id`, `type`, `kind`, `install_id`, `session_id`, `turn_id`, `ts`, `received_at`, and `payload_json`. Never log the raw payload. Add a simple per-IP + install token bucket (e.g., 60 requests/minute) with an in-memory map.

- [ ] **Step 4: Run the ingest tests**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add src/ingest src/server/app.ts src/shared test/ingest.test.ts
git commit -m "feat: add idempotent ingest api"
```

---

### Task 4: Aggregation queries and admin APIs

**Files:**
- Create: `../hotpot-telemetry/src/db/queries.ts`
- Modify: `../hotpot-telemetry/src/server/app.ts`
- Create: `../hotpot-telemetry/test/queries.test.ts`

**Interfaces:**
- Produces: `queryOverview(db, { from, to, kind })`, `queryCost`, `queryPerformance`, `querySuccess`, `queryErrors`, `queryInstalls`, `querySessions`.
- Each returns plain JSON-safe objects; ranges are `24h`, `7d`, `30d`.

- [ ] **Step 1: Write the failing query tests**

Seed events for two installs, two days, success/error/aborted turns, two models/tiers, and tool calls. Assert:
- overview turn counts and success rate;
- cost sums input/output by model/tier;
- performance returns avg and p95 turn duration;
- success returns task and tool rates;
- errors groups by code and sanitized message;
- `kind=benchmark` excludes user events.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/queries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the queries and routes**

Use SQLite JSON1 (`json_extract(payload_json, '$.field')`) for event fields. Compute p95 with `ORDER BY duration_ms LIMIT 1 OFFSET floor(count*0.95)`. Expose read-only routes from spec §7.4; all accept `range` and `kind`. Return `{ data: ... }` consistently. Add `GET /api/v1/export?format=csv|json`.

- [ ] **Step 4: Run the query tests**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add src/db/queries.ts src/server/app.ts test/queries.test.ts
git commit -m "feat: add aggregation apis"
```

---

### Task 5: Single-operator authentication

**Files:**
- Create: `../hotpot-telemetry/src/server/auth.ts`
- Modify: `../hotpot-telemetry/src/server/app.ts`
- Create: `../hotpot-telemetry/test/auth.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/login { password }` → signed `hp_admin` cookie.
- Produces: `requireAdmin(c)` middleware for all `/api/v1/*` routes except ingest and health.
- Consumes: `ADMIN_PASSWORD` from config; HMAC secret derived from it with `node:crypto`.

- [ ] **Step 1: Write the failing tests**

Correct password sets an HttpOnly cookie; wrong password → 401; protected route without cookie → 401; with cookie → 200; logout clears it.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement auth**

Sign `${expiresAt}.${hmac}` with SHA-256; store the expiry and signature in the cookie; verify on every request. Use `SameSite=Strict`, `HttpOnly`, `Secure` when `NODE_ENV=production`. No password hashing needed because the password is an env secret compared in constant time.

- [ ] **Step 4: Run the auth tests**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add src/server/auth.ts src/server/app.ts test/auth.test.ts
git commit -m "feat: add single-operator auth"
```

---

### Task 6: Alert rules, scheduler, and channels

**Files:**
- Create: `../hotpot-telemetry/src/alerts/rules.ts`
- Create: `../hotpot-telemetry/src/alerts/evaluate.ts`
- Create: `../hotpot-telemetry/src/alerts/channels.ts`
- Create: `../hotpot-telemetry/src/alerts/scheduler.ts`
- Modify: `../hotpot-telemetry/src/server/app.ts`
- Create: `../hotpot-telemetry/test/alerts.test.ts`

**Interfaces:**
- Produces: `evaluateRules(rules, metrics, now): AlertTransition[]`.
- Produces: `sendAlert(channels, payload, deps): Promise<DeliveryResult[]>`.
- Produces CRUD routes `GET/POST/PATCH/DELETE /api/v1/alert-rules` and `POST /api/v1/alert-rules/:id/test`.
- Channels: `email` (nodemailer), `webhook` (POST JSON), `feishu` (POST `{msg_type:"text", content:{text}}`).

- [ ] **Step 1: Write the failing tests**

Cases: threshold crossing fires once; cooldown suppresses a second fire; recovery resolves; a channel failure records a delivery row and does not throw; Feishu payload has `msg_type: "text"`; generic webhook body has `rule/state/value/window/firedAt/summary`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/alerts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement rules, evaluation, channels, scheduler**

Rule fields: `metric` (`success_rate|error_rate|p95_turn_duration|turn_tokens|no_data`), `window_minutes`, `comparator` (`gt|lt`), `threshold`, `cooldown_minutes`, `channels_json`, `enabled`. The scheduler runs every 60s, computes metrics, calls `evaluateRules`, persists `alert_events`, and sends channels with 3 retries. Store every attempt in `deliveries`.

- [ ] **Step 4: Run the alert tests**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/alerts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add src/alerts src/server/app.ts test/alerts.test.ts
git commit -m "feat: add alert rules and delivery"
```

---

### Task 7: React admin dashboard

**Files:**
- Create: `../hotpot-telemetry/web/index.html`
- Create: `../hotpot-telemetry/web/vite.config.ts`
- Create: `../hotpot-telemetry/web/src/main.tsx`
- Create: `../hotpot-telemetry/web/src/App.tsx`
- Create: `../hotpot-telemetry/web/src/api.ts`
- Create: `../hotpot-telemetry/web/src/pages/{Overview,Cost,Performance,Success,Errors,Alerts,Installs}.tsx`
- Create: `../hotpot-telemetry/test/web.test.ts`
- Modify: `../hotpot-telemetry/src/server/app.ts` (serve `web/dist` with SPA fallback)

**Interfaces:**
- The SPA calls the JSON APIs from Task 4 and Task 6; login posts to `/api/v1/login`.
- Build output `web/dist` is served at `/`; `/api/*` stays JSON.

- [ ] **Step 1: Write the failing UI smoke test**

Do not add a DOM test stack. Write `test/web.test.ts` as a build/API smoke test: `vite build` succeeds and `web/dist/index.html` exists; a mocked `fetch` asserts the query string for range/kind.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/web.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the SPA**

Login page; a left nav with Overview/Cost/Performance/Success/Errors/Installs/Alerts; a range selector (24h/7d/30d) and kind filter (user/benchmark); simple tables and bar/line charts using plain SVG (no chart library). All pages render an empty state for zero data. Alerts page lists rules, supports create/edit/test, and shows delivery history. Do not render any content fields because none are stored.

- [ ] **Step 4: Run the web test and build**

Run: `cd ../hotpot-telemetry && pnpm exec vitest run test/web.test.ts && pnpm run build:web`
Expected: PASS and `web/dist/index.html` exists.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add web src/server/app.ts test/web.test.ts
git commit -m "feat: add admin dashboard"
```

---

### Task 8: Deployment files and smoke test

**Files:**
- Create: `../hotpot-telemetry/.env.example`
- Create: `../hotpot-telemetry/Dockerfile`
- Create: `../hotpot-telemetry/docker-compose.yml`
- Create: `../hotpot-telemetry/scripts/backup.sh`
- Create: `../hotpot-telemetry/scripts/smoke.sh`
- Create: `../hotpot-telemetry/README.md`
- Create: `../hotpot-telemetry/AGENTS.md`

**Interfaces:**
- `docker compose up -d` serves on `${PORT:-4580}`, persists `./data`.
- `GET /healthz` returns `{ ok: true }`.

- [ ] **Step 1: Write the deployment smoke test script**

Create `scripts/smoke.sh` that builds the image, starts compose, waits for `/healthz`, posts a fixture batch with the ingest token, calls `/api/v1/overview`, and exits non-zero on any failure. Run it in a temp `DATA_DIR`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ../hotpot-telemetry && bash scripts/smoke.sh`
Expected: FAIL because the files do not exist.

- [ ] **Step 3: Implement the deployment files**

Dockerfile: `node:22-slim`, install build tools for `better-sqlite3`, `pnpm install --prod=false`, build web, run `tsx src/server/index.ts`. Compose mounts `./data:/app/data`, exposes `4580`. `.env.example` lists every variable from the spec. README covers local dev, deploy on `sell_system`, security group, TLS via reverse proxy, backup/restore, retention, and alert channel setup. AGENTS covers the no-content rule, single-operator scope, and test commands.

- [ ] **Step 4: Run the smoke test**

Run: `cd ../hotpot-telemetry && bash scripts/smoke.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add .env.example Dockerfile docker-compose.yml scripts README.md AGENTS.md
git commit -m "chore: add deployment and smoke test"
```

---

### Task 9: Deploy and verify end-to-end from the tool

**Files:**
- Modify: `../hotpot-telemetry/README.md` (deployment record)

- [ ] **Step 1: Deploy on sell_system**

Copy the project to `sell_system` (rsync), create `.env` with a strong `ADMIN_PASSWORD` and `INGEST_TOKEN`, run `docker compose up -d`, and confirm `curl http://127.0.0.1:4580/healthz`.

- [ ] **Step 2: Open the public port**

Ask the operator to allow the chosen port in the Tencent Cloud security group. Verify from the local machine: `curl http://<sell_system-ip>:4580/healthz`.

- [ ] **Step 3: Send a real batch from the tool**

Run the CLI with `telemetry.endpoint` pointing at the service and `telemetry.token` set; complete one short turn; confirm the admin overview shows one turn and that no prompt/reply text appears in SQLite (`SELECT payload_json FROM telemetry_events LIMIT 1`).

- [ ] **Step 4: Record the result**

Append the deployment host, port, date, and verification output to the README. Do not commit secrets.

- [ ] **Step 5: Commit**

```bash
cd ../hotpot-telemetry
git add README.md
git commit -m "docs: record deployment verification"
```
