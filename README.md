# Privacy Wallet

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

    subgraph Backend["Privacy Wallet backend (Railway)"]
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

## The SPP session signer: known limitation and the mainnet path

Opening the Shielded tab creates a second account — an ed25519 `G…` "session
signer" — and funds it from friendbot before anything can be shielded. We
audited the vendored SPP source to understand whether that is forced by the
protocol. It is not; it is an SDK limitation, and the friendbot step is a
testnet stand-in for a mechanism that exists on mainnet.

**What the contracts actually require.** Nothing about address type. The
pool's `transact` accepts any `sender: Address`, requiring only
`sender.require_auth()` before pulling the deposit via SAC transfer
(`contracts/pool/src/pool.rs:513-533` in
[stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments));
withdrawals pay out to any `ext_data.recipient: Address` (`pool.rs:620`); the
public-key registry registers any `owner: Address` and stores X25519 + BN254
keys — not an ed25519 identity — and is "not required to interact with the
pool" per its own docs (`contracts/public-key-registry/src/lib.rs`).

**What the SDK requires.** Its whole client path is ed25519-native: the user
address is parsed as an `ed25519::PublicKey` (`sdk/stellar/src/signer.rs:221`),
auth entries are signed as ed25519 signature maps (`signer.rs:320-338`), the
transaction envelope needs a classic G source account with a sequence number
(`sdk/stellar/src/tx_prepare.rs:50`), and the privacy keys (note key,
encryption key) are derived from a 64-byte ed25519 signature over a fixed
message (`sdk/prover/src/encryption.rs`). A passkey (WebAuthn/secp256r1)
signature can satisfy none of these — notably, WebAuthn assertions are
non-deterministic, so they can never be a key-derivation input. Hence the
separate ed25519 session key (generated at onboarding, stored in the encrypted
backup) and the `G…` account it controls.

**Why friendbot, and why that's only a testnet artifact.** A `G…` account
must exist as a ledger entry before it can hold anything: a SAC `transfer`
cannot create one (SAC error 6, `AccountMissingError`), and a `C…` smart
account cannot originate a classic `CreateAccount` op. Friendbot is simply
the one account-creator available on testnet — its 10 000 XLM grant is
friendbot's fixed amount, not our choice. On mainnet the same job is done by
**CAP-33 sponsored reserves**: the app operator's fee account submits
`BeginSponsoringFutureReserves(session)` → `CreateAccount(session, 0)` →
`EndSponsoringFutureReserves`, creating the session account with **zero**
XLM (the sponsor carries the base reserve). The user then funds deposits from
their own smart-account balance via SAC transfer, and transaction fees ride
the same relayer channel the CT rail already uses. No free money, no
friendbot.

**The deeper fix: no session account at all.** Because the pool is
address-type-agnostic, a forked SDK could use the smart account itself as
`sender`: deposits would pull straight from the smart account's balance,
withdrawals would pay straight back to it, auth would be the same
passkey-signed Soroban auth entries this wallet already produces for the CT
rail, and key derivation would take deterministic bytes from the wallet's
backup secret instead of an ed25519 signature (the SDK's 64-byte check is a
length check; no chain-side rule cares where the bytes come from). The
session account — and the account-creation problem with it — disappears.

**Update (2026-08-04): we shipped that fork.** The SDK is vendored at
`vendor/stellar-private-payments` — the commit on top of the pristine
upstream tree is the complete change: a 116-line diff adding a
`txSource`/identity split and an `executeTransaction` signer seam. The app
now opens the pool as the wallet's own `C…` address; shield pulls straight
from the smart account's public XLM (passkey-authorized), unshield pays
straight back to it, shielded recipients are addressed by wallet `C…`
address, and friendbot is out of the SPP flow entirely. Verified live on
testnet (wallet `CCLBXDQJ…MGTPT3`): register
[`d917470b…`](https://stellar.expert/explorer/testnet/tx/d917470bfbfbfa7a12dd17246523633e330b930196b2f5a4ad2b1103ac9ea76d),
shield 5 XLM
[`352efbca…`](https://stellar.expert/explorer/testnet/tx/352efbca9657ea08c9a180f90d0ae841b6faf9971c3b53e0da193d2d58332b3b),
unshield 2 XLM
[`e5e2a26a…`](https://stellar.expert/explorer/testnet/tx/e5e2a26a6d9184fbce8c6a8b0a966c8aaf260920fe6e6ac9e8af7bdc3b9e5d8b),
shielded send 1 XLM
[`b443e940…`](https://stellar.expert/explorer/testnet/tx/b443e9406f34170e0ac300ccec82cf4a3bcf215b7f42ccbf27d7d2f78ff49ce9)
— public balance 10,000 → 9,997 XLM exactly, pool balance 3 XLM across 2
notes. The paragraphs above are kept as the design rationale and as the
no-fork alternative (CAP-33 sponsorship) for anyone using the stock SDK.

**A note on privacy.** The session account is *not* a privacy feature. On
the proposed mainnet flow it is funded from the user's own wallet, a
trivially traceable one-hop link; the pool's privacy comes from the shielded
set between deposit and withdrawal, not from who the depositor is. Collapsing
the session account into the smart account loses nothing real — deposit and
withdrawal edges are public in either design.

## Yield-bearing shielded pool (our contract fork)

Idle liquidity sitting in a privacy pool is doing nothing — every deposit
that hasn't been withdrawn yet just sits in the contract's own balance
earning zero yield. We forked the SPP pool contract to change that:
deposits above a threshold get batch-invested into a
[DeFindex](https://defindex.io) vault, and the fork lets an admin skim only
the yield that accrues above what's owed back to depositors, as a protocol
fee funding continued development. Source: `contracts/pool-yield/` (deep
dive: `docs/modules/pool-yield.md`).

**The balance-sheet invariant.** The contract tracks a running liability
counter — the sum of every deposit minus every withdrawal, i.e. exactly what
it owes back to note holders. Surplus is `(idle balance + vault position) −
liabilities`, clamped at zero, and that's the *only* number the yield-skim
function is capable of paying out. This isn't a policy the admin agrees to
respect — it's the arithmetic: liabilities only grow on a deposit and only
shrink on a withdrawal, so subtracting them from total assets structurally
excludes note-backed funds from ever being paid as "yield," regardless of
how the skim function is called or how many times.

**Batching is for gas and liquidity management, not extra privacy.** Idle
deposits get invested together in one vault call once they cross a
threshold, rather than one vault call per deposit — this saves gas and
avoids constantly toggling small amounts in and out of the vault. It does
**not** make anyone's deposit more private. Every SPP deposit's amount is
already a public input to its proof and the deposit transaction itself is
public on-chain — batching the *investment* timing reveals nothing about
individual deposits that wasn't already visible per-transaction. If you were
hoping the invest step adds a privacy mixing effect on top of the pool
itself: it doesn't, and we didn't design it to.

**Per-user yield is not possible with this contract, on purpose (sealed note
amounts).** A note's value is a field element inside a commitment — it never
appears in cleartext on-chain, so the contract has no way to know which
depositor a given slice of surplus "belongs" to. The liability counter and
surplus figure are necessarily pool-wide aggregates; yield is collected as
one lump sum, never attributed or paid per-user. Building real per-user
yield attribution would need new circuits — e.g. fixed-denomination shields
(notes minted only in a small set of standard sizes, so a note's
denomination alone hints at eligible principal without decrypting its
contents) is one hardening option we discussed in design review but have
not built. If per-user yield distribution matters to you, treat it as a
known gap, not a subtle bug we missed.

**Addresses (testnet).** Pool:
`CC3AVJZR5MSOLLNNP7DYSG3KR7MTBE4N4VMAT5ZX4NWIJTQL75RNI3F5` (deployed ledger
3,968,245). DeFindex vault:
`CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7`. Nethermind's
original (non-yield) pool stays live at
`CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI` purely so
pre-fork notes stay visible/spendable through our indexer — new deposits go
to the yield pool above. Full deployment record:
`contracts/deployments/pool-yield-testnet.json`.

## Monorepo layout

```
app/                # React 19 + Vite wallet SPA — passkey onboarding, CT rail, SPP rail, unified Activity view
api/                # @privacy-wallet/api — Postgres-backed indexer worker + REST/bootnode HTTP server
packages/shared/     # @privacy-wallet/shared — TESTNET network/contract config, shared CT invoke glue
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
pnpm --filter @privacy-wallet/api run db:migrate          # applies api/drizzle/0000_...sql
pnpm --filter @privacy-wallet/api run backfill:spp:load   # loads api/fixtures/spp-backfill.json (518 SPP events) + initializes the SPP stream cursor
```

The backfill step is **required** — without it, the SPP rail's history sync
has nothing to catch up on and the worker's SPP stream would otherwise start
by hammering the (dead) public Nethermind bootnode. Both commands are
idempotent; safe to re-run.

### 2. API + worker

```bash
pnpm --filter @privacy-wallet/api dev      # REST + bootnode server, http://localhost:3000
pnpm --filter @privacy-wallet/api worker   # indexer worker (separate process, same DB)
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

Selective Privacy Pool (`packages/shared/src/config.ts`'s `TESTNET.spp`;
the ASP membership/non-membership roots, public key registry, verifier, and
EURC pool are a shared testnet deployment we don't control — the native-XLM
pool is now **our own** yield-bearing fork, deployed at ledger 3,968,245,
see the section above):

| Contract | Address |
|---|---|
| Pool (native XLM, our yield fork) | `CC3AVJZR5MSOLLNNP7DYSG3KR7MTBE4N4VMAT5ZX4NWIJTQL75RNI3F5` |
| Pool (native XLM, legacy — pre-fork notes only) | `CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI` |
| Pool (EURC) | `CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74` |
| Public key registry | `CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36` |
| ASP membership | `CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K` |
| DeFindex vault (our yield pool invests idle liquidity here) | `CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7` |

See `docs/modules/contracts.md` for the CT deploy/import procedure and
`docs/modules/shared.md` for the full `TESTNET` config shape (smart-account
WASM hash, relayer URL, RPC/Horizon URLs).

## Bootnode usage (for other builders)

**Note (2026-08-04):** the SPP pool contract was redeployed as our
yield-bearing fork at the source level (see "Yield-bearing shielded pool"
above) and `packages/shared/src/config.ts`/`api/src/worker.ts` were updated
to track it, but the production `api`/`worker` services have **not yet been
redeployed** with that change (verified live: a `getEvents` call with the
new 5-contract set below still gets `-32602 unsupported filters` from the
deployed bootnode, while the 4-contract set with the OLD pool address still
works). The example below reflects what's **currently live**, not the
source's current state. See `docs/modules/deploy.md`'s Gotchas for the
required redeploy sequence (backfill re-run BEFORE the worker deploy) —
once that ships, this section needs updating to the 5-contract set
(`pool`, `poolLegacy`, `poolEurc`, `aspMembership`, `publicKeyRegistry`).

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
- `api`: 173 tests (`pnpm --filter @privacy-wallet/api test`, with `DATABASE_URL`
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
