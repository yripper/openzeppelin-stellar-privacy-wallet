# api Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `api/` · **Last verified:** 2026-07-31

## Purpose

`@grantfox/api` — the Postgres-backed indexer package for the privacy
wallet. This bootstrap (Task 5) ships the schema, the drizzle client
factory, and the `IndexerRepo` data-access surface that later tasks build
on: the indexer worker (Task 7, polling the CT contract's events + the
Nethermind bootnode), the normalizer (Task 8, turning raw `events` into
account-facing `ct_activity`), and the Fastify API server (Task 9,
serving activity feeds to `app`). No worker loop, normalizer, or HTTP
server exists yet — this task is schema + repo only.

## Structure

| File | Purpose |
|---|---|
| `api/src/db/schema.ts` | drizzle `pgTable` definitions for the four tables: `events`, `ct_activity`, `cursors`, `bootnode_pages`. Exports `*Row`/`New*Row` inferred types per table. |
| `api/src/db/client.ts` | `createDb(url): { db, pool }` — builds a `pg.Pool` + `drizzle-orm/node-postgres` handle bound to `schema`. Caller owns `pool.end()`. |
| `api/src/db/repo.ts` | `createRepo(db): IndexerRepo` — the data-access surface: batch `insertEvents` (on-conflict-do-nothing by `id`), `getCursor`/`setCursor`, `insertCtActivity`, `insertBootnodePage`/`getBootnodePage`, and `withTransaction(fn)` which re-scopes all of the above to a single Postgres transaction. |
| `api/src/lib/env.ts` | `loadEnv(source?)` — zod-validated process env: `DATABASE_URL` (required), `POLL_INTERVAL_MS` (optional, default `5000`, consumed by the Task 7 worker). |
| `api/src/index.ts` | Public package entry point; re-exports the above. |
| `api/drizzle.config.ts` | `drizzle-kit` config — schema path, migrations `out: ./drizzle`, `dialect: postgresql`, reads `DATABASE_URL` (falls back to the local docker default). |
| `api/drizzle/0000_unusual_captain_marvel.sql` | First (and, as of this task, only) migration — `CREATE TABLE` for all four tables. |
| `api/src/db/schema.test.ts` | Offline: asserts each table's column names/types/PK against this doc (drizzle `getTableColumns`/`getTableName`), plus an `events.id` format check. |
| `api/src/lib/env.test.ts` | Offline: `loadEnv` required/default/coercion/failure cases. |
| `api/src/db/repo.test.ts` | Integration, `describe.skipIf(!process.env.DATABASE_URL)`: round-trips every `IndexerRepo` method against the local docker Postgres, including transaction commit/rollback. |

## Endpoints / Public surface

- `createDb(url: string): { db: Db; pool: Pool }` — `api/src/db/client.ts`.
- `createRepo(db: Db): IndexerRepo` — `api/src/db/repo.ts`.
- `IndexerRepo` / `RepoOps` — `api/src/db/repo.ts`. `RepoOps`: `insertEvents(rows)`, `getCursor(key)`, `setCursor(key, value)`, `insertCtActivity(rows)`, `insertBootnodePage(row)`, `getBootnodePage(cursorIn)`. `IndexerRepo` adds `withTransaction(fn)`.
- `loadEnv(source?): Env` — `api/src/lib/env.ts`. `Env = { DATABASE_URL: string; POLL_INTERVAL_MS: number }`.
- Tables + inferred row types (`events`/`EventRow`/`NewEventRow`, `ctActivity`/`CtActivityRow`/`NewCtActivityRow`, `cursors`/`CursorRow`/`NewCursorRow`, `bootnodePages`/`BootnodePageRow`/`NewBootnodePageRow`) — `api/src/db/schema.ts`.

## Key methods

- `createDb` — `api/src/db/client.ts:11`.
- `createRepo` / `buildRepoOps` — `api/src/db/repo.ts:83`, `api/src/db/repo.ts:39`.
- `loadEnv` — `api/src/lib/env.ts:16`.

## Dependencies

- `drizzle-orm` (`^0.45`, `drizzle-orm/node-postgres`) + `pg` (`^8`) — Postgres access.
- `drizzle-kit` (dev, `^0.31`) — migration generation (`db:generate`) and apply (`db:migrate`); config in `api/drizzle.config.ts`.
- `zod` (`^3.24`) — env validation.
- `@grantfox/shared` (`workspace:*`), `@stellar/stellar-sdk` (pinned `16.2.0`) and `fastify` (`^5`) — declared per the task-5 brief for the API server (Task 9) and future CT-aware routes; unused by this task's code.
- Local Postgres: repo-root `docker-compose.yml` (`postgres:16-alpine`, user/pass/db `grantfox`, host port `${DB_HOST_PORT:-5433}`). `DATABASE_URL` default: `postgres://grantfox:grantfox@localhost:5433/grantfox` — set in repo-root `.env` and `.env.example`.
- `events.id` format (`${ledger}-${txHash}-${opIndex}-${eventIndex}`) matches `@ctd/sdk`'s `naturalEventId` (`packages/ctd-sdk/src/chain/events.ts:236`) — callers (Task 7) construct the id via that function, not a local reimplementation; `api` does not depend on `@ctd/sdk`.

## Gotchas & invariants

- `insertEvents` is on-conflict-do-nothing **by `id` only** — a re-inserted row with the same id but different payload is silently ignored (the first write wins). This is intentional for idempotent worker restarts, but means a genuine data-correction requires a manual `UPDATE`, not a re-insert.
- `insertBootnodePage` is also on-conflict-do-nothing by `cursorIn`, same idempotency rationale — a page fetch for an already-cached `cursorIn` is a no-op even if `response` would differ.
- `setCursor` is a real upsert (`onConflictDoUpdate`), unlike the two above — cursors are meant to move forward and always reflect the latest value.
- `withTransaction`'s callback receives a `RepoOps` bound to the transaction handle (not the outer `IndexerRepo`), so it can call any insert/query helper but not nest another `withTransaction`.
- `ct_activity.amount` is the only nullable column in the schema; everything else (including `bootnode_pages.cursor_out` / `last_event_ledger`) is `NOT NULL` per the task-5 brief's literal column list — there was no signal to make anything else optional.
- `cursors.updated_at` and `bootnode_pages.created_at` default to `now()` at the DB level (`defaultNow()`), not application code — this wasn't spelled out in the brief but matches the "troqpay shape" convention for timestamped audit tables.
- `api/tsconfig.json` excludes `src/**/*.test.ts` from the `build` output — test files are type-checked by `vitest` (esbuild transpile, not full `tsc`) and separately by a full-tree `tsc --noEmit` during review, not by `pnpm build`.

## Testing

- `pnpm --filter @grantfox/api test` (`vitest run`) — offline: 10 tests (`env.test.ts` ×5, `schema.test.ts` ×5) always run; `repo.test.ts` ×6 auto-skip when `DATABASE_URL` is unset.
- Integration: `docker compose up -d postgres` (repo root), then `DATABASE_URL=postgres://grantfox:grantfox@localhost:5433/grantfox pnpm --filter @grantfox/api test` — all 16 tests pass, including `repo.test.ts`'s transaction commit/rollback and on-conflict-do-nothing round-trips.
- Migration apply: `docker compose up -d postgres` then `DATABASE_URL=... pnpm --filter @grantfox/api exec drizzle-kit migrate` — verified applying `0000_unusual_captain_marvel.sql` cleanly to a fresh volume, `\dt`/`\d <table>` column-by-column matches the brief.
- `pnpm --filter @grantfox/api build` (`tsc -p tsconfig.json`) — verified clean.
