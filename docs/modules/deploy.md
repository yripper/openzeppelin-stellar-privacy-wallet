# deploy Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `railway/`, `app/server.mjs` · **Last verified:** 2026-08-02 (Task 13 — initial deploy)

## Purpose

Task 13 — puts the three app-layer processes (`api`, `worker`, `app`) and a
managed Postgres on the public internet via Railway, deployed from the local
checkout (`railway up`, no GitHub connection — this repo has no git remote).
`api`/`worker` build straight from `api/dist/{server,worker}.js` (Task 9/7);
`app` is the built Vite SPA (Task 10-12) served by a small dependency-free
static file server, `app/server.mjs`, that sets the same COOP/COEP headers
`app/vite.config.ts`'s dev/preview servers set — bb.js's multithreaded
UltraHonk prover needs `crossOriginIsolated === true` in production too, not
just in dev.

## Structure

| File | Purpose |
|---|---|
| `app/server.mjs` | Production static server for `app/dist` (plain `node:http`, zero dependencies). Sets `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` on every response (mirrors `app/vite.config.ts`'s `crossOriginIsolationHeaders`), plus `Cross-Origin-Resource-Policy: cross-origin` on `/vendor/bb/*` and `/spp/*` (the two vendored asset trees, fetched as sub-resources by a COEP document). SPA fallback: any path that isn't a real file under `dist/` serves `index.html`, so react-router's client routes resolve on a hard load. Listens on `process.env.PORT` (Railway injects this), host `0.0.0.0`. |
| `railway/api.json` | Config-as-code for the `api` service. `build.buildCommand`: `pnpm install --frozen-lockfile && pnpm --filter @grantfox/shared build && pnpm --filter @ctd/sdk build && pnpm --filter @grantfox/api build` (shared-monorepo pattern — no `rootDirectory`, since `api` imports `@grantfox/shared`/`@ctd/sdk` as workspace packages). `deploy.startCommand`: `node api/dist/server.js` (repo-root-relative, since there's no `rootDirectory`). `deploy.healthcheckPath`: `/health`. |
| `railway/worker.json` | Same build as `api.json` (identical dependency graph — `worker.ts` and `server.ts` are separate entrypoints off the same `api/dist`). `deploy.startCommand`: `node api/dist/worker.js`. No healthcheck (not an HTTP service). |
| `railway/app.json` | `build.buildCommand`: `pnpm install --frozen-lockfile && pnpm --filter @grantfox/shared build && pnpm --filter @ctd/sdk build && pnpm --filter app build` — `pnpm --filter app build` runs `prebuild` (`pnpm run vendor`, copying `@aztec/bb.js` + `stellar-private-payments` into `app/public/`) via pnpm's standard lifecycle-script hook before `tsc --noEmit && vite build`. `deploy.startCommand`: `node app/server.mjs`. |

Each service's Railway "Config File" setting (GraphQL `ServiceInstanceUpdateInput.railwayConfigFile`) points at its file — `/railway/api.json`, `/railway/worker.json`, `/railway/app.json` (leading slash = repo-root-relative; per Railway's own monorepo docs this path does **not** follow a service's `rootDirectory`, which is moot here since none of these three services sets one — see Gotchas for why the CLI's `railway environment edit --service-config` dot-path editor doesn't expose this particular field and how it was set instead). Config-as-code always overrides dashboard settings for the deployment it applies to (Railway's own semantics — see Gotchas), so these three JSON files are the actual source of truth for build/start commands, not the dashboard.

## Endpoints / Public surface

- **api** — `https://api-production-70a0.up.railway.app` (`GET /health`, `GET /contracts/:contractId/events`, `GET /accounts/:address/activity`, `POST /rpc` — see `docs/modules/api.md`).
- **app** — `https://app-production-2f5e.up.railway.app` (the wallet SPA).
- **worker** — no public endpoint; background process, `RAILWAY_SERVICE_NAME=worker`.
- **Postgres** — private-network only (`postgres.railway.internal:5432`); no public TCP proxy is left running (see Gotchas — one was created transiently for the one-time migration/backfill step, then deleted).

## Key methods (`file:line`)

- Static file server entrypoint — `app/server.mjs:1` (whole file is the entrypoint; `resolveFile` at `app/server.mjs:36`).
- Config-as-code build/start commands — `railway/api.json:1`, `railway/worker.json:1`, `railway/app.json:1`.

## Dependencies

- Railway project `grantfox-privacy-wallet` (id `9841ff18-bed2-42e0-91ee-9063947ddb4c`), workspace `coderipper's Projects`, single environment `production` (id `e4a5ba0b-8eb4-42e6-ba54-b7ad1c621797`).
- Services: `Postgres` (Railway's official Postgres template, `ghcr.io/railwayapp-templates/postgres-ssl:18`, id `a609ec4f-816e-42c0-8f3a-b0a86dfc06b8`) · `api` (id `59b75b99-bd4a-47a9-ab0f-41088297c4f6`) · `worker` (id `09287e2b-94e5-4646-94d1-af1a6b692011`) · `app` (id `9d481fba-36df-4afb-a8ec-050909c1afde`).
- `api`/`worker` env: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway reference variable, resolves to the private-network connection string — see `api/src/lib/env.ts`, Task 5). No other env vars are required: `POLL_INTERVAL_MS`/`RPC_URL`/`BOOTNODE_URL`/`PORT` all default correctly for testnet (`packages/shared/src/config.ts`'s `TESTNET`), and `PORT` is Railway-injected for `api` regardless. `RAILPACK_NODE_VERSION=22` is pinned on all three app-layer services (see Gotchas).
- `app` env: `VITE_API_URL` = `api`'s public domain (`https://api-production-70a0.up.railway.app`) — **must be set before the `app` service's build runs**, since Vite inlines `import.meta.env.VITE_*` vars at build time, not runtime (`app/src/lib/api-url.ts`). Deploy order was: generate `api`'s domain → set `VITE_API_URL` on `app` → deploy `app`.
- **No secret beyond `DATABASE_URL`.** `CT_AUDITOR_SECRET_HEX` (present in the repo's local `.env`/`.env.example`) is not imported anywhere in `api/` or `app/` source (verified: `grep -rn "AUDITOR_SECRET" --include="*.ts" .` outside `node_modules` returns nothing) — it exists only for local ops scripts, not needed by any deployed service. `PUBLIC_API_URL` (named in the task brief) is likewise not read anywhere in source; only `VITE_API_URL` (`app/src/lib/api-url.ts:15`) matters.

## Gotchas & invariants

- **Railway CLI v5.27.2's `railway environment edit --service-config <svc> <path> <value>` dot-path editor silently no-ops on unrecognized paths** (confirmed live: `build.configFilePath "..."` returned `{"committed":false,"message":"No changes to apply"}` and never appeared in `railway environment config --json`). The real field is `railwayConfigFile` on `ServiceInstanceUpdateInput` (confirmed via GraphQL schema introspection, `__type(name: "ServiceInstanceUpdateInput")`), set through the `serviceInstanceUpdate(serviceId, environmentId, input)` mutation — not exposed by the CLI's dot-path editor as of this version. Set directly via GraphQL for all three services; verified afterward via `railway environment config --json`, which surfaces it back as `services.<id>.configFile`.
- **This CLI session authenticates via OAuth (`accessToken`/`refreshToken` in `~/.railway/config.json`), not a static API token** (`.user.token` is `null`). The Railway MCP server's mutation tools (`create_project`, `update_service`, etc.) and the `use-railway` skill's own `scripts/railway-api.sh` helper both read `.user.token` and failed with "Unauthorized" for this session, even though the CLI itself (`railway whoami`, `railway up`, …) worked fine and MCP's read-only list calls (`list_projects`, `list_workspaces`) also worked. Every mutation in this deploy went through the `railway` CLI directly, or — for the one GraphQL-only field above — a one-off `curl` using `.user.accessToken` as the bearer token.
- **`RAILPACK_NODE_VERSION=22` is pinned** on `api`/`worker`/`app` because Railway's Railpack builder defaulted to Node 24 (confirmed live), and a quick local repro under Node 24.12.0 found `node api/dist/server.js` crashing inside `node:internal/util/inspect` (not this repo's code) when `console.error`-formatting the `ZodError` `loadEnv()` throws for a **missing** `DATABASE_URL` — a Node-version-specific `util.inspect` regression, not reachable in production (`DATABASE_URL` is always set via the Postgres reference variable) but pinned to the tested Node 22 line as a defensive measure anyway, matching the repo's `engines.node: ">=22"` (`package.json:6`) and this task's own local verification (`node -v` → `v24.12.0` locally, but the repo's build/test history is against 22.x per `CLAUDE.md`/prior task reports).
- **Postgres has no public TCP proxy by default** — `${{Postgres.DATABASE_PUBLIC_URL}}` only resolves once one exists (`RAILWAY_TCP_PROXY_DOMAIN`/`_PORT` are otherwise empty, producing a malformed `postgresql://user:pass@:/db` URL). One was created transiently (`railway tcp-proxy create --port 5432 --service Postgres`) purely to run the one-time post-deploy migration (`drizzle-kit migrate`) and SPP backfill loader (`pnpm --filter @grantfox/api backfill:spp:load`) from a local shell against the prod DB, then **deleted** immediately after (`railway tcp-proxy delete <id> --service Postgres --yes`) to avoid leaving a password-protected-but-internet-reachable Postgres endpoint running unnecessarily. **Any future migration needs to recreate it first**: `railway tcp-proxy create --port 5432 --service Postgres --environment production`, read `DATABASE_PUBLIC_URL` via `railway variable list --service Postgres --environment production --json`, run the migration/backfill with that as `DATABASE_URL`, then delete the proxy again.
- **The worker's first deploy raced the migration.** `worker` and `api` were deployed in parallel (independent builds), so `worker`'s process started, found no `cursors`/`events` tables yet, and began exponential-backoff retries (`api/src/worker.ts:29`'s `backoffDelayMs`, capped at 60s) logging `relation "cursors" does not exist`. This is harmless by design (per-stream isolation, capped backoff) and would have self-healed within a minute of the migration completing, but it was restarted once (`railway restart --service worker --yes`) after the migration + backfill landed, to get it polling cleanly from a clean slate rather than waiting out the existing backoff window. **Deploying `worker` only after `api`'s migration has run avoids this entirely on a from-scratch redeploy.**
- **`app`'s build must run strictly after `VITE_API_URL` is set on the `app` service**, not just before the app is *used* — Vite bakes `import.meta.env.VITE_API_URL` into the built JS at `vite build` time (`app/src/lib/api-url.ts`). Setting it after the build (or relying on a runtime env var) has no effect; the build has to be re-triggered.

## Testing

**2026-08-02 — prod smoke, all live against the deployed services** (full transcripts, deployment/service IDs, and the exact commands run: `.superpowers/sdd/2026-07-31-privacy-wallet/task-13-report.md`, gitignored):

- `GET https://api-production-70a0.up.railway.app/health` → `{"latest_synced_ledger":N}`, observed advancing from the backfill's tip (`3898969`) to the live chain tip (`3919954`) once the worker caught up.
- `POST https://api-production-70a0.up.railway.app/rpc` `getEvents` with the SDK's exact 4-contract SPP filter set (`type:"contract"`, `topics:[["**"]]`, `contractIds`=`buildSppContractIds()`) → real backfilled SPP events (pool nullifier/commitment events from ledger 3773975 on), `latestLedger` matching the live tip.
- `GET https://api-production-70a0.up.railway.app/contracts/CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH/events?startLedger=3900251` → real CT contract events (constructor-setter events + a `register` event), ingested live by the worker's CT stream (pure-RPC, no backfill needed — the CT contract's `deployedAtLedger` is well within Soroban RPC's retention window, unlike SPP's much older deployment ledger).
- App domain loads (`https://app-production-2f5e.up.railway.app/`, Playwright): `window.crossOriginIsolated === true`; landing page renders ("Create a new wallet" / "I already have a wallet"); clicking through reaches `/onboarding` and renders the passkey-creation form ("Create your wallet", a `Display name` field, "Create wallet with passkey"). Zero console errors during the whole navigation.
- `curl -I` on `/`, `/vendor/bb/index.js`, `/spp/stellar_private_payments_sdk_web.js` — COOP/COEP present on all three; CORP `cross-origin` present only on the latter two (not on `/`), matching `app/server.mjs`'s path-scoped header logic.
- Worker: `railway logs --service worker --since 5m` — clean (no repeated errors) after the post-migration restart; both streams (`ct:CBTEJFLW...`, `spp:CAWCZ6EO...,...`) polling without per-tick failures.
