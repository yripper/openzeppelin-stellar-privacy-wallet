# GrantFox Privacy Wallet

A Stellar wallet that combines two independent privacy rails — **Confidential
Transfers (CT)** and a **Selective Privacy Pool (SPP)** — behind one
passkey-secured smart account, plus the indexer/bootnode infrastructure both
rails actually need to work on testnet today.

- **Passkey smart accounts.** No seed phrase to back up for day-to-day use —
  `smart-account-kit` deploys a WebAuthn-secured Soroban smart account
  (`C…` address) and submits transactions through a fee-sponsoring relayer.
- **Confidential Transfers.** Register a shielded balance, deposit, send, and
  withdraw with real client-side zero-knowledge proofs (UltraHonk, via
  `@aztec/bb.js`, proven in-browser). Amounts are encrypted on-chain; the
  wallet decrypts its own activity.
- **Selective Privacy Pool.** Shield XLM into a pool, send privately between
  pool participants, unshield back out. Shield/unshield are the two *public
  boundary* events (money crosses the public/private line); everything that
  happens inside the pool — including who sent what to whom — stays hidden.
- **Our own indexer + bootnode.** Both rails need event history the public
  Stellar infrastructure can't give them past its retention window — see
  [Why we run our own indexer](#why-we-run-our-own-indexer-and-bootnode)
  below, and the [bootnode usage](#bootnode-usage-for-other-builders) section
  if you want to point your own SPP client at ours.
- **Auditor-side compliance.** The CT contracts support an ops-held auditor
  key that can decrypt transfer ciphertexts for compliance review, without
  the sender or recipient's cooperation — see
  [Compliance story](#compliance-story-auditor-decrypt).

## Deployed (testnet)

| Service | URL |
|---|---|
| Wallet app | https://app-production-2f5e.up.railway.app |
| API (REST + bootnode) | https://api-production-70a0.up.railway.app |

Both verified live as of this writing: `GET /health` on the API returns the
indexer's current synced ledger, and the app serves the onboarding flow.

## Architecture

```mermaid
flowchart TB
    subgraph Browser["Browser — app/ (React 19 SPA)"]
        UI["Wallet UI<br/>(Onboarding · Wallet · Shielded · Activity tabs)"]
        Passkey["WebAuthn passkey<br/>(smart-account-kit)"]
        CT["CT rail<br/>UltraHonk proving (bb.js, in-browser)"]
        SPP["SPP rail<br/>Groth16 proving (SDK's own worker)"]
    end

    subgraph Chain["Stellar Testnet"]
        SA["Smart account contract (C…)"]
        RPC["Soroban RPC"]
        CTC["CT contracts<br/>token / verifier / auditor"]
        SPPC["SPP contracts<br/>pool / poolEurc / aspMembership / registry"]
    end

    Relayer["SDF Channels relayer proxy<br/>(fee-sponsored submission)"]

    subgraph Backend["GrantFox backend (Railway)"]
        API["api — REST activity + JSON-RPC bootnode (POST /rpc)"]
        Worker["worker — indexer, polls RPC on an interval"]
        DB[("Postgres<br/>events · ct_activity · cursors")]
    end

    Passkey --> SA
    UI -- sign & submit --> Relayer --> RPC
    CT --> CTC
    SPP --> SPPC
    RPC --- SA
    RPC --- CTC
    RPC --- SPPC

    UI -- "GET /accounts/:addr/activity" --> API
    SPP -- "bootnodeUrl: API's /rpc (pool history)" --> API
    API --> DB
    Worker -- polls --> RPC
    Worker --> DB

    OtherBuilder["Other SPP builders"] -. "POST /rpc (see bootnode usage)" .-> API
```

## Why we run our own indexer and bootnode

Both rails hit the same wall on testnet: **event history older than the RPC's
retention window is gone from public infrastructure**, and each rail's
reference bootnode is unusable for a different reason.

- **SPP**: the pool's deployment ledger (3,773,948) predates the public
  Soroban RPC's retention window. The SPP SDK falls back to a bootnode for
  historical sync (`Indexer::init` → `RpcSyncGap` → bootnode catch-up) — but
  Nethermind's own public SPP bootnode rejects every request with
  `-32602 unsupported filters` (verified live, see `docs/modules/api.md`'s
  "Live-verification blocker"). Without a working bootnode, an SPP client
  cannot sync the pool's history **at all**.
- We recovered the pool's full history from stellar.expert's public archive
  (`api/scripts/backfill-spp.ts`, 518 events, 4 contracts) and now serve it —
  plus everything since, kept current by our worker — from our own
  bootnode-protocol endpoint, `POST /rpc` on the API service. **This is
  currently the only live, working SPP bootnode for this pool deployment
  anywhere.**
- **CT**: our own REST API (`GET /accounts/:address/activity`) serves
  normalized confidential-token activity straight from Postgres, so the
  wallet's activity feed works past the RPC's own retention window too,
  without re-deriving it from raw events client-side every time.

## Monorepo layout

```
app/                # React 19 + Vite wallet SPA — passkey onboarding, CT rail, SPP rail, unified Activity view
api/                # @grantfox/api — Postgres-backed indexer worker + REST/bootnode HTTP server
packages/shared/     # @grantfox/shared — TESTNET network/contract config, shared CT invoke glue
packages/ctd-sdk/    # @ctd/sdk — vendored Confidential Token client SDK (witness/proving/chain/state)
contracts/           # CT contract suite deployment record (testnet) + deploy/import procedure
railway/             # Config-as-code for the three Railway services (api/worker/app)
docs/modules/        # Living per-module documentation (read before touching a module)
scripts/             # Root-level scripts (smoke-ct.ts — gate #1 smart-account/CT lifecycle smoke test)
```

## Local run instructions

Requirements: Node ≥ 22, pnpm ≥ 10, Docker (for local Postgres).

```bash
pnpm install
```

### 1. Database

```bash
docker compose up -d postgres                     # postgres:16-alpine on localhost:5433 (see docker-compose.yml)
cp .env.example .env                               # DATABASE_URL defaults to postgres://grantfox:grantfox@localhost:5433/grantfox
pnpm --filter @grantfox/api run db:migrate          # applies api/drizzle/0000_...sql
pnpm --filter @grantfox/api run backfill:spp:load   # loads api/fixtures/spp-backfill.json (518 SPP events) + initializes the SPP stream cursor
```

The backfill step is **required** — without it, the SPP rail's history sync
has nothing to catch up on and the worker's SPP stream would otherwise start
by hammering the (dead) public Nethermind bootnode. Both commands are
idempotent; safe to re-run.

### 2. API + worker

```bash
pnpm --filter @grantfox/api dev      # REST + bootnode server, http://localhost:3000
pnpm --filter @grantfox/api worker   # indexer worker (separate process, same DB)
```

### 3. App

```bash
cp app/.env.example app/.env         # VITE_API_URL defaults to http://localhost:3000
pnpm --filter app dev                # http://localhost:5173
```

The app needs the API running (both for the CT activity feed and, for the
Shielded tab, as the SPP pool's history source — see above) — start it after
step 2.

### Build + test everything

```bash
pnpm build   # builds packages/shared, packages/ctd-sdk, api, app (`pnpm -r build`)
pnpm test    # runs every workspace's test suite (`pnpm -r test`)
```

`api`'s suite needs `DATABASE_URL` pointed at a running Postgres for its full
count (`docker compose up -d postgres` first, from the repo root) — without
it, its DB-integration tests auto-skip rather than fail. See
[Testing](#testing) below for exact counts.

## Contract addresses (testnet)

Confidential Token suite (`contracts/deployments/testnet.json`, deployed at
ledger 3,900,251):

| Contract | Address |
|---|---|
| Token | `CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH` |
| Verifier | `CBDQQ75BKSAO2TG4D37PKVJZ64F4Y3AHKTSY3NXV6DPEACSDWO4TBGQH` |
| Auditor | `CB27W7M4PLVGC77X5LPNZEOX5UCUWYJ3CODSBR6JR2WJEO66E4BGBDKA` |
| Underlying asset (native XLM SAC) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

Selective Privacy Pool (`packages/shared/src/config.ts`'s `TESTNET.spp`,
deployed at ledger 3,773,948 — this is a shared testnet deployment, not one
we control):

| Contract | Address |
|---|---|
| Pool (native XLM) | `CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI` |
| Pool (EURC) | `CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74` |
| Public key registry | `CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36` |
| ASP membership | `CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K` |

See `docs/modules/contracts.md` for the CT deploy/import procedure and
`docs/modules/shared.md` for the full `TESTNET` config shape (smart-account
WASM hash, relayer URL, RPC/Horizon URLs).

## Bootnode usage (for other builders)

If you're building an SPP client against this same testnet pool deployment
and need historical event sync, you can point your client at our bootnode
instead of standing up your own indexer:

```
https://api-production-70a0.up.railway.app/rpc
```

It speaks the same JSON-RPC 2.0 bootnode protocol the SPP SDK expects
(`getLatestLedger`, `getEvents`) — if you're using the official
`stellar-private-payments` JS SDK, just pass it as `bootnodeUrl`:

```ts
import { Client } from "stellar-private-payments";

const client = await Client.new({
  rpcUrl: "https://soroban-testnet.stellar.org",
  storage /* ... */,
  proverWorkerUrl /* ... */,
  bootnodeUrl: "https://api-production-70a0.up.railway.app/rpc",
});
```

**Constraints, so you don't hit a confusing error:**

- **`getEvents` only accepts one exact filter set** — a single `contract`
  filter with `topics: [["**"]]` and `contractIds` set-equal (order doesn't
  matter) to this pool's full 4-contract sync set:
  `CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI` (pool),
  `CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74` (poolEurc),
  `CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K` (aspMembership),
  `CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36` (publicKeyRegistry).
  Any other filter set returns `-32602 unsupported filters` — this is not a
  general-purpose bootnode, it only serves this one pool deployment's exact
  contract set (the same allow-list the official SDK itself requests when it
  syncs this pool).
- Provide exactly one of `startLedger` or `pagination.cursor`, never both.
- Once you've paged past our indexed tip, `getEvents` returns
  `-32002` (a retention-handoff response with `fromLedger`) — this is the
  SDK's own signal to resume on the main RPC, not an error to work around.
- Manual curl example (verified live against the URL above):

  ```bash
  curl -s https://api-production-70a0.up.railway.app/rpc \
    -H 'content-type: application/json' \
    -d '{
      "jsonrpc":"2.0","id":1,"method":"getEvents",
      "params":{
        "startLedger":3773948,
        "filters":[{"type":"contract","contractIds":[
          "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
          "CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74",
          "CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K",
          "CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36"
        ],"topics":[["**"]]}],
        "pagination":{"limit":10}
      }
    }'
  ```

Full protocol details (validation order, error codes, why our
handoff/cache-miss semantics deliberately diverge from the reference
bootnode's stateful cache): `docs/modules/api.md`'s `modules/bootnode/`
entries.

## Compliance story (auditor decrypt)

The CT contracts are deployed with an on-chain auditor public key
(`auditorId: 0`, `contracts/deployments/testnet.json`); every confidential
transfer's ciphertext includes an auditor-decryptable component alongside the
sender/recipient one. The auditor's private key (`CT_AUDITOR_SECRET_HEX`) is
held ops-side — in this environment's local `.env`, **never committed** — and
`@ctd/sdk`'s `src/auditor/` module can decrypt any transfer's amount with it,
independent of either party's cooperation. This is script-demonstrable (not
wired into the app's UI, since end users never hold this key): given the
secret and a transfer event's on-chain ciphertext fields, the auditor module
recovers the amount the same way `packages/ctd-sdk/test/auditor.mjs` proves
it does.

Combined with the SPP side's Association Set Provider (ASP) — pool
participants must be ASP-approved before their shielded transactions go
through, an off-chain compliance gate the wallet surfaces as "not yet
approved by the pool's association-set provider" when it applies — both
rails pair privacy with a real compliance story, not privacy at the expense
of one.

## Attribution

- **`packages/ctd-sdk/`** (`@ctd/sdk`) is vendored from
  [`brozorec/stellar-confidential-token-demo`](https://github.com/brozorec/stellar-confidential-token-demo)
  (commit `ac67499a617c084b80c0e0298180b2c4faf9e2fb`, `packages/sdk`), MIT
  licensed. Full provenance and the running list of local modifications:
  `packages/ctd-sdk/ATTRIBUTION.md`.
- **`app/`'s SPP rail** is built against the `stellar-private-payments`
  browser SDK (`0.1.0-alpha.1`) and its vendored Circom/Groth16 prover
  workers — see `docs/modules/app.md`'s Task 12 entry for integration
  details.
- **Passkey smart accounts** via `smart-account-kit` (OpenZeppelin), with
  fee-sponsored submission through SDF's public Channels relayer proxy.

## License

No license file is published in this repository — this is a hackathon
submission, not a released package. The vendored `@ctd/sdk` code retains its
own upstream MIT license (see `packages/ctd-sdk/ATTRIBUTION.md`).

## Testing

- `app`: 119 tests (`pnpm --filter app test`), `typecheck`, and `build` all
  green.
- `api`: 173 tests (`pnpm --filter @grantfox/api test`, with `DATABASE_URL`
  set against a running Postgres for the full count — DB-integration cases
  auto-skip otherwise), `build` green.
- `packages/shared`: 7 tests, `build` green.
- `packages/ctd-sdk`: its `parity.mjs` (7 cases) and `prove.mjs` (3 real
  UltraHonk proofs) suites pass; its full vendored `pnpm test` script also
  runs `disclosure.mjs`, which fails on a pre-existing, unrelated gap — a
  sibling `@ctd/disclosure` package (needed only for selective-disclosure
  circuits) was never vendored into this monorepo. Documented since Task 4
  (`docs/modules/ctd-sdk.md`'s Gotchas) and reconfirmed unrelated to any
  later task's changes (`docs/modules/api.md`'s Task 9 testing notes).

See `docs/modules/README.md` for the per-module documentation index — read
the relevant module doc before changing anything, it has the file map,
`file:line` references, dependencies, and gotchas that took real debugging
time to learn.
