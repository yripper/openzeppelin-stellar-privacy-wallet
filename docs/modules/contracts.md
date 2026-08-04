# contracts Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `contracts/` · **Last verified:** 2026-08-04

## Purpose

Two independent things share this directory:

1. The deployment record for the Confidential Token (CT) contract suite
   on Stellar testnet, plus the procedure to reproduce/refresh that
   deployment. This part holds no contract source or WASM — it is the
   tracked output of a deploy run against the gitignored
   `resources/stellar-confidential-token-demo` reference clone.
   `packages/shared/src/config.ts`'s `TESTNET.ct` block is the
   machine-readable projection of this deployment that the rest of the
   monorepo imports.
2. The `pool-yield` Soroban contract — source **is** vendored in this
   repo at `contracts/pool-yield/` (a fork of
   `vendor/stellar-private-payments/contracts/pool` with an added
   invest/divest/liability layer) — plus its testnet deployment record.
   Unlike the CT suite, this one is built and deployed directly from
   this repo, not an external reference clone.

## Structure

| File | Purpose |
|---|---|
| `contracts/README.md` | CT suite: deploy procedure (run from `resources/stellar-confidential-token-demo`), import steps (strip `auditor.secretHex`, populate `.env`/`config.ts`), current deployment address table, on-chain verification commands. `pool-yield`: fork provenance, shared-infra (verifier/ASP) sourcing note, build/deploy/smoke-test commands (`contracts/README.md`'s "pool-yield (yield-bearing SPP pool)" section). |
| `contracts/deployments/testnet.json` | The imported CT deployment record — network, contract addresses (`token`, `verifier`, `auditor`, `underlying`, `allowlist`, `blocklist`, `factory`), `deployedAtLedger`, auditor's public Grumpkin key (`id`, `keyXHex`, `keyYHex` — **no `secretHex`**), and `addrF` (Poseidon2 hash of the token address). Shape (minus the stripped secret) mirrors upstream `resources/stellar-confidential-token-demo/scripts/_shared.ts:31-52`. |
| `contracts/deployments/pool-yield-testnet.json` | `pool-yield`'s testnet deployment record — network/rpcUrl/passphrase, `deployedAtLedger`, `contract` (C-address), and the full constructor argument set (`admin`, `token`, `verifier`, `aspMembership`, `aspNonMembership`, `maximumDepositAmount`, `levels`, `policyFlags`, `vault`, `investThreshold`, `liquidityBuffer`). |
| `contracts/pool-yield/` | The `pool-yield` Soroban contract crate (source, `Cargo.toml`, tests) — vendored/forked, not gitignored. See `contracts/README.md`'s "pool-yield" section for build/deploy. |

## Endpoints / Public surface

- CT deployment: no code exports. Consumers read `TESTNET.ct` from
  `@privacy-wallet/shared` (`packages/shared/src/config.ts`) rather than
  this JSON directly.
- `pool-yield`: no dedicated TS config export yet (nothing in
  `packages/shared/src/config.ts` reads `deployments/pool-yield-testnet.json`
  as of this deployment) — consumers currently read the `<POOL_YIELD_ID>`
  contract address straight out of that JSON file. The contract's own
  invocable surface (17 exported functions incl. `transact`,
  `collect_yield`, `get_surplus`, `get_invest_params`, `get_vault`,
  `get_root`) lives in `contracts/pool-yield/src/pool.rs`.

## Key methods

- CT: N/A — data-only. The deploy logic lives upstream in
  `resources/stellar-confidential-token-demo/scripts/deploy.ts` (not part
  of this repo's tracked source).
- `pool-yield` (`contracts/pool-yield/src/pool.rs`): `get_vault`
  (`pool.rs:795`), `get_invest_params` (`pool.rs:803`), `get_liabilities`
  (`pool.rs:818`), `get_surplus`/`collect_yield`/`update_invest_params`
  (`pool.rs:1060-1123`) — the invest/divest/liability layer added on top
  of the verbatim-forked upstream pool logic (`transact`, ASP root
  getters, etc.).

## Dependencies

- CT: Produced by `resources/stellar-confidential-token-demo` (gitignored
  reference clone; same upstream `@ctd/sdk` is vendored from — see
  `packages/ctd-sdk/ATTRIBUTION.md`), via its `pnpm deploy:contracts`
  script and the `stellar` CLI.
- CT: Consumed by: `packages/shared/src/config.ts` (`TESTNET.ct`), and
  transitively by any later package that reads CT contract addresses from
  `@privacy-wallet/shared`.
- CT: The auditor's private key (`CT_AUDITOR_SECRET_HEX` in the repo-root
  `.env`, gitignored) is a sibling secret to this module's public data —
  needed to decrypt auditor ciphertexts client-side, never read from this
  directory.
- `pool-yield`: depends on `vendor/stellar-private-payments/contracts/{types,soroban-utils}`
  (path deps, `contracts/pool-yield/Cargo.toml`) and, for the deployed
  instance, three externally-owned contracts it does **not** own or
  deploy: the ZK verifier and both ASP roots are **Nethermind's**
  existing testnet deployment (addresses cross-checked against
  `packages/shared/src/config.ts:21-22` for the ASP roots; verifier
  address sourced from
  `vendor/stellar-private-payments/deployments/testnet/deployments.json:8`),
  and the DeFindex vault (`CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7`)
  it invests idle deposits into.
- `pool-yield`'s `token` argument is the same native XLM SAC as the CT
  suite's `underlying` (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`)
  — the two deployments share that one contract, otherwise unrelated.

## Gotchas & invariants

- **Never commit `auditor.secretHex`.** The upstream deploy script writes
  it into its own `deployments/testnet.json` inside the (gitignored)
  reference clone; the import step into this repo strips it before the
  file is copied to `contracts/deployments/testnet.json`. If re-running a
  deploy, re-check the diff for the secret hex value before committing.
- A fresh deploy produces **new contract addresses** (and a new auditor
  key/secret) every time — `admin`'s deploys are not idempotent/resumable
  across runs. Re-deploying means re-running the full import procedure in
  `contracts/README.md`, not hand-editing individual fields.
- The token contract has no `auditor`-named read function; verify a
  deployment via `stellar contract read --id <token>` (instance storage)
  or the auditor contract's `get_key --auditor_id 0`, not a literal
  `invoke -- auditor` call. See `contracts/README.md`'s verification
  section.
- `deployedAtLedger` is captured **before** the token contract deploy
  transaction (`ledgerBeforeToken` in upstream `deploy.ts`), not after —
  intentionally conservative so an indexer polling from this ledger never
  misses the deploy/registration events.
- `allowlist`, `blocklist`, `factory` addresses are recorded in
  `deployments/testnet.json` for completeness but are **not** part of the
  `TESTNET.ct` interface in `@privacy-wallet/shared` — that block only surfaces
  `token`, `verifier`, `auditor`, `underlying`, `deployedAtLedger`,
  `auditorId`, `addrF`.
- `pool-yield` builds require the `VERIFIER_VK_JSON` env var
  (`contracts/README.md`'s "Build" subsection) pointing at a
  verification-key JSON file (e.g.
  `vendor/stellar-private-payments/testdata/selectiveDisclosure_1_vk.json`)
  — `stellar contract build` embeds it into the WASM; omitting it fails
  the build.
- `pool-yield`'s `--levels 10` constructor argument is not an arbitrary
  choice — it must match the merkle tree depth already in use by the
  wallet's live SPP integration (verified on-chain against
  `CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI`'s persistent
  `Levels` storage entry before every redeploy; see `contracts/README.md`'s
  "Deploy" subsection). Deploying with a mismatched depth would silently
  break root/proof compatibility with the rest of the SPP client code.
- `pool-yield` redeploys, like the CT suite, are **not** idempotent —
  each `stellar contract deploy` mints a new C-address and ledger, and
  `deployments/pool-yield-testnet.json` must be regenerated (not
  hand-edited) to match.

## Testing

- CT: No automated tests (data-only module). Verification is a manual
  on-chain read after import — see `contracts/README.md`'s "Verifying a
  deployment on-chain" section. Confirmed for the current deployment:
  `stellar contract read --id <token> --network testnet` shows
  `Auditor`/`Verifier`/`UnderlyingAsset`/`AddressAsField` matching
  `deployments/testnet.json` exactly, and
  `stellar contract invoke --id <auditor> ... -- get_key --auditor_id 0`
  returns `keyXHex || keyYHex` from the same file.
- `pool-yield`: 37/37 Rust unit tests pass in the crate itself (`cargo
  test` from `contracts/pool-yield/`, with `VERIFIER_VK_JSON` set — see
  Build above). On-chain smoke test after each deploy (six read-only
  `stellar contract invoke --send no` calls — `get_vault`,
  `get_invest_params`, `get_liabilities`, `get_surplus`,
  `get_policy_flags`, `get_root`) is documented in `contracts/README.md`'s
  "Smoke test" subsection; confirmed passing for the current deployment in
  `deployments/pool-yield-testnet.json`.
