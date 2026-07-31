# contracts Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `contracts/` · **Last verified:** 2026-07-31

## Purpose

Deployment record for the Confidential Token (CT) contract suite on
Stellar testnet, plus the procedure to reproduce/refresh that deployment.
This module holds no contract source or WASM — it is the tracked output
of a deploy run against the gitignored `resources/stellar-confidential-token-demo`
reference clone. `packages/shared/src/config.ts`'s `TESTNET.ct` block is
the machine-readable projection of this deployment that the rest of the
monorepo imports.

## Structure

| File | Purpose |
|---|---|
| `contracts/README.md` | Deploy procedure (run from `resources/stellar-confidential-token-demo`), import steps (strip `auditor.secretHex`, populate `.env`/`config.ts`), current deployment address table, on-chain verification commands. |
| `contracts/deployments/testnet.json` | The imported deployment record — network, contract addresses (`token`, `verifier`, `auditor`, `underlying`, `allowlist`, `blocklist`, `factory`), `deployedAtLedger`, auditor's public Grumpkin key (`id`, `keyXHex`, `keyYHex` — **no `secretHex`**), and `addrF` (Poseidon2 hash of the token address). Shape (minus the stripped secret) mirrors upstream `resources/stellar-confidential-token-demo/scripts/_shared.ts:31-52`. |

## Endpoints / Public surface

- No code exports. Consumers read `TESTNET.ct` from `@grantfox/shared`
  (`packages/shared/src/config.ts`) rather than this JSON directly.

## Key methods

- N/A — data-only module. The deploy logic lives upstream in
  `resources/stellar-confidential-token-demo/scripts/deploy.ts` (not part
  of this repo's tracked source).

## Dependencies

- Produced by `resources/stellar-confidential-token-demo` (gitignored
  reference clone; same upstream `@ctd/sdk` is vendored from — see
  `packages/ctd-sdk/ATTRIBUTION.md`), via its `pnpm deploy:contracts`
  script and the `stellar` CLI.
- Consumed by: `packages/shared/src/config.ts` (`TESTNET.ct`), and
  transitively by any later package that reads CT contract addresses from
  `@grantfox/shared`.
- The auditor's private key (`CT_AUDITOR_SECRET_HEX` in the repo-root
  `.env`, gitignored) is a sibling secret to this module's public data —
  needed to decrypt auditor ciphertexts client-side, never read from this
  directory.

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
  `TESTNET.ct` interface in `@grantfox/shared` — that block only surfaces
  `token`, `verifier`, `auditor`, `underlying`, `deployedAtLedger`,
  `auditorId`, `addrF`.

## Testing

- No automated tests (data-only module). Verification is a manual
  on-chain read after import — see `contracts/README.md`'s "Verifying a
  deployment on-chain" section. Confirmed for the current deployment:
  `stellar contract read --id <token> --network testnet` shows
  `Auditor`/`Verifier`/`UnderlyingAsset`/`AddressAsField` matching
  `deployments/testnet.json` exactly, and
  `stellar contract invoke --id <auditor> ... -- get_key --auditor_id 0`
  returns `keyXHex || keyYHex` from the same file.
