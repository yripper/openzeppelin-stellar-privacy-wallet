# api Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `api/` · **Last verified:** 2026-07-31

## Purpose

`@grantfox/api` — the Postgres-backed indexer package for the privacy
wallet. Task 5 shipped the schema, the drizzle client factory, and the
`IndexerRepo` data-access surface. Task 6 (this update) adds the two event
sources the indexer worker (Task 7) will poll: `fetchRpcEvents` (Soroban
RPC `getEvents`) and `fetchBootnodeEvents` (the SPP bootnode's cached
`getEvents`, used to bootstrap history past the RPC's retention window
until it hands off back to the RPC). Both return the same `EventsPage`
shape so Task 7 can switch sources without branching on origin. No worker
loop, normalizer, or HTTP server exists yet.

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
| `api/src/lib/soroban-events.ts` | `fetchRpcEvents(rpcUrl, {contractIds, startLedger?, cursor?, limit}): Promise<EventsPage>` — wraps `rpc.Server.getEvents` (sdk-16). Also exports `EventsPage`, `RawEvent`, `naturalEventId`, `eventIndexFromId` (shared with `bootnode-client.ts`). Pure I/O adapter: no DB access, no retry/backoff. |
| `api/src/lib/bootnode-client.ts` | `fetchBootnodeEvents(url, {contractIds, startLedger?, cursor?}): Promise<EventsPage \| {handoff: {fromLedger: number}}>` — JSON-RPC 2.0 POST to the SPP bootnode's `getEvents`. Maps `-32002` (retention handoff) to a `{handoff}` return value, throws `BootnodeCacheMissError` on `-32004`. Pure I/O adapter, `fetch`-based, mocked in tests. |
| `api/src/lib/soroban-events.test.ts` | Offline: mocks `rpc.Server.prototype.getEvents` (`vi.spyOn`); valid-page mapping, cursor-vs-startLedger request shape, missing-`startLedger`/`cursor` guard, missing-`contractId` mapping error, `eventIndexFromId`/`naturalEventId` unit cases. |
| `api/src/lib/bootnode-client.test.ts` | Offline: mocks global `fetch` (`vi.stubGlobal`); wire-shape (`pagination.cursor`, `deny_unknown_fields`-safe body) assertions, valid-page mapping, `-32002` handoff mapping, both `-32004` message variants, an unmapped JSON-RPC error code, missing-required-field mapping error, missing-`startLedger`/`cursor` guard. |

## Endpoints / Public surface

- `createDb(url: string): { db: Db; pool: Pool }` — `api/src/db/client.ts`.
- `createRepo(db: Db): IndexerRepo` — `api/src/db/repo.ts`.
- `IndexerRepo` / `RepoOps` — `api/src/db/repo.ts`. `RepoOps`: `insertEvents(rows)`, `getCursor(key)`, `setCursor(key, value)`, `insertCtActivity(rows)`, `insertBootnodePage(row)`, `getBootnodePage(cursorIn)`. `IndexerRepo` adds `withTransaction(fn)`.
- `loadEnv(source?): Env` — `api/src/lib/env.ts`. `Env = { DATABASE_URL: string; POLL_INTERVAL_MS: number }`.
- Tables + inferred row types (`events`/`EventRow`/`NewEventRow`, `ctActivity`/`CtActivityRow`/`NewCtActivityRow`, `cursors`/`CursorRow`/`NewCursorRow`, `bootnodePages`/`BootnodePageRow`/`NewBootnodePageRow`) — `api/src/db/schema.ts`.
- `fetchRpcEvents(rpcUrl, opts): Promise<EventsPage>`, `fetchBootnodeEvents(url, opts): Promise<EventsPage | {handoff: {fromLedger: number}}>`, `EventsPage`, `RawEvent`, `naturalEventId`, `eventIndexFromId`, `BootnodeCacheMissError` — `api/src/lib/soroban-events.ts`, `api/src/lib/bootnode-client.ts`.

## Key methods

- `createDb` — `api/src/db/client.ts:11`.
- `createRepo` / `buildRepoOps` — `api/src/db/repo.ts:83`, `api/src/db/repo.ts:39`.
- `loadEnv` — `api/src/lib/env.ts:16`.
- `fetchRpcEvents` — `api/src/lib/soroban-events.ts:146`.
- `fetchBootnodeEvents` — `api/src/lib/bootnode-client.ts:142`.

## Dependencies

- `drizzle-orm` (`^0.45`, `drizzle-orm/node-postgres`) + `pg` (`^8`) — Postgres access.
- `drizzle-kit` (dev, `^0.31`) — migration generation (`db:generate`) and apply (`db:migrate`); config in `api/drizzle.config.ts`.
- `zod` (`^3.24`) — env validation.
- `@grantfox/shared` (`workspace:*`), `@stellar/stellar-sdk` (pinned `16.2.0`) and `fastify` (`^5`) — declared per the task-5 brief for the API server (Task 9) and future CT-aware routes. As of Task 6, `@stellar/stellar-sdk` (`rpc`, `xdr` types) is used by `soroban-events.ts`; `fastify` remains unused until Task 9.
- Local Postgres: repo-root `docker-compose.yml` (`postgres:16-alpine`, user/pass/db `grantfox`, host port `${DB_HOST_PORT:-5433}`). `DATABASE_URL` default: `postgres://grantfox:grantfox@localhost:5433/grantfox` — set in repo-root `.env` and `.env.example`.
- `events.id` format (`${ledger}-${txHash}-${opIndex}-${eventIndex}`) matches `@ctd/sdk`'s `naturalEventId` (`packages/ctd-sdk/src/chain/events.ts:236`). `api/src/lib/soroban-events.ts` exports its own `naturalEventId`/`eventIndexFromId` that REPLICATE (not import) that logic — `@ctd/sdk` pulls in the zk-proving stack (`@aztec/bb.js`, `@noir-lang/noir_js`), which `@grantfox/api` has no other reason to depend on. Task 7 should construct `events` rows from `RawEvent` (which already carries a correctly-formatted `id`), not reimplement the format a third time.

## Gotchas & invariants

- `insertEvents` is on-conflict-do-nothing **by `id` only** — a re-inserted row with the same id but different payload is silently ignored (the first write wins). This is intentional for idempotent worker restarts, but means a genuine data-correction requires a manual `UPDATE`, not a re-insert.
- `insertBootnodePage` is also on-conflict-do-nothing by `cursorIn`, same idempotency rationale — a page fetch for an already-cached `cursorIn` is a no-op even if `response` would differ.
- `setCursor` is a real upsert (`onConflictDoUpdate`), unlike the two above — cursors are meant to move forward and always reflect the latest value.
- `withTransaction`'s callback receives a `RepoOps` bound to the transaction handle (not the outer `IndexerRepo`), so it can call any insert/query helper but not nest another `withTransaction`.
- `ct_activity.amount` is the only nullable column in the schema; everything else (including `bootnode_pages.cursor_out` / `last_event_ledger`) is `NOT NULL` per the task-5 brief's literal column list — there was no signal to make anything else optional.
- `cursors.updated_at` and `bootnode_pages.created_at` default to `now()` at the DB level (`defaultNow()`), not application code — this wasn't spelled out in the brief but matches the "troqpay shape" convention for timestamped audit tables.
- `api/tsconfig.json` excludes `src/**/*.test.ts` from the `build` output — test files are type-checked by `vitest` (esbuild transpile, not full `tsc`) and separately by a full-tree `tsc --noEmit` during review, not by `pnpm build`.
- `fetchRpcEvents`/`fetchBootnodeEvents` both derive `RawEvent.id` as `${ledger}-${txHash}-${opIndex}-${eventIndex}`; `opIndex`/`txIndex` come directly off sdk-16's `operationIndex`/`transactionIndex` fields (no toid bit-masking needed, unlike `@ctd/sdk`'s older-SDK-targeting `rpcEventCoords`), but `eventIndex` still has no dedicated field on either source and is parsed from the second segment of the event `id` (`<toid>-<eventOrder>`) by the shared `eventIndexFromId` helper.
- `RawEvent.topic`/`valueXdr` are base64-encoded XDR strings for BOTH sources, not decoded native values — `fetchRpcEvents` re-encodes the SDK's parsed `xdr.ScVal`s via `.toXDR("base64")`; `fetchBootnodeEvents` passes the bootnode's already-base64 wire strings straight through. Decoding to CT-specific native values (event names, addresses, amounts) is left to the normalizer (Task 8), not done here.
- `fetchRpcEvents` throws if an `EventResponse.contractId` is `undefined` — it does NOT fall back to a single "requested" contract id (unlike troqpay's `soroban-gateway.ts`, whose `getContractEvents` fell back to its one request-scoped `contractId`), because this adapter filters by potentially MULTIPLE `contractIds` and a wrong fallback would silently mislabel a row's contract.
- `fetchBootnodeEvents` throws if a mapped event is missing `operationIndex`/`transactionIndex`/`txHash`/`inSuccessfulContractCall` (all `Option` on the bootnode's Rust `Event` struct) — the `events` table requires them `NOT NULL` and the id can't be built without `txHash`/`operationIndex`, so this adapter fails fast rather than guessing.
- The bootnode's wire params nest `cursor`/`limit` under `params.pagination`, NOT flat on `params` — `GetEventsParams` is `#[serde(deny_unknown_fields)]` server-side, so a flat body is rejected. Neither `soroban-events.ts` nor `bootnode-client.ts` retries or logs; Task 7 owns all retry/backoff policy (including on `BootnodeCacheMissError`).

## Testing

- `pnpm --filter @grantfox/api test` (`vitest run`) — offline: 27 tests (`env.test.ts` ×5, `schema.test.ts` ×5, `soroban-events.test.ts` ×8, `bootnode-client.test.ts` ×9) always run; `repo.test.ts` ×6 auto-skip when `DATABASE_URL` is unset.
- Integration: `docker compose up -d postgres` (repo root), then `DATABASE_URL=postgres://grantfox:grantfox@localhost:5433/grantfox pnpm --filter @grantfox/api test` — all 33 tests pass, including `repo.test.ts`'s transaction commit/rollback and on-conflict-do-nothing round-trips.
- `soroban-events.test.ts`/`bootnode-client.test.ts` mock `rpc.Server.prototype.getEvents`/global `fetch` respectively — neither hits a live network endpoint.
- Migration apply: `docker compose up -d postgres` then `DATABASE_URL=... pnpm --filter @grantfox/api exec drizzle-kit migrate` — verified applying `0000_unusual_captain_marvel.sql` cleanly to a fresh volume, `\dt`/`\d <table>` column-by-column matches the brief.
- `pnpm --filter @grantfox/api build` (`tsc -p tsconfig.json`) — verified clean.
