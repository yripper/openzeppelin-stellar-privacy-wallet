# Shared Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `packages/shared/` · **Last verified:** 2026-07-31 (added `buildCtInvokeTx`)

## Purpose

Cross-package config and constants for the privacy-wallet monorepo, published as `@privacy-wallet/shared`. Every other package (`app`, `api`, and any later `packages/*`) imports network config, contract addresses, and shared types from here instead of hardcoding them — so a testnet/mainnet or contract-redeploy change happens in one place.

## Structure

| File | Purpose |
|---|---|
| `packages/shared/src/config.ts` | `TESTNET` config object — RPC/Horizon URLs, network passphrase, smart-account and SPP (Selective Privacy Pool) contract addresses. |
| `packages/shared/src/ct-tx.ts` | Confidential Token invoke glue — `buildCtInvokeOp` / `buildCtInvokeTx`. Documented in depth in [`ct-tx.md`](ct-tx.md). |
| `packages/shared/src/ct-tx.test.ts` | Offline vitest suite for the above (arg-encoding round-trip + stubbed-RPC build/simulate path). |
| `packages/shared/src/index.ts` | Public entry point; re-exports `TESTNET` and the CT invoke glue. |
| `packages/shared/tsconfig.json` | Extends root `tsconfig.base.json`; emits to `dist/`. |
| `packages/shared/package.json` | Package manifest: build (`tsc -p tsconfig.json`), test (`vitest run`). |

## Endpoints / Public surface

- `TESTNET` (`packages/shared/src/config.ts:1`) — `as const` object with:
  - `rpcUrl`, `horizonUrl`, `networkPassphrase`, `nativeSac`
  - `smartAccount.{accountWasmHash, webauthnVerifierAddress, ed25519VerifierAddress, relayerUrl}`
  - `spp.{pool, publicKeyRegistry, aspMembership, aspNonMembership, deploymentLedger, nethermindBootnode}`
  - `ct.{token, verifier, auditor, underlying, deployedAtLedger, auditorId, addrF}` — Confidential Token contract suite on testnet; sourced from `contracts/deployments/testnet.json` (see `docs/modules/contracts.md` for the deploy/import procedure and provenance). The auditor's private key is deliberately **not** here — it lives in the repo-root `.env` as `CT_AUDITOR_SECRET_HEX`.
- `buildCtInvokeTx(cfg, contractId, method, args)` (`packages/shared/src/ct-tx.ts:65`) — build + simulate an `AssembledTransaction` for a Confidential Token call, leaving auth entries unsigned. See [`ct-tx.md`](ct-tx.md).
- `buildCtInvokeOp(contractId, method, args)` (`packages/shared/src/ct-tx.ts:38`) — the pure `invokeContractFunction` op behind it.
- `CtInvokeConfig` (`packages/shared/src/ct-tx.ts:24`) — `{ rpcUrl, networkPassphrase, source }`.

## Key methods

- See [`ct-tx.md`](ct-tx.md) for `buildCtInvokeTx` / `buildCtInvokeOp`. Everything else in this module is static config.

## Dependencies

- `@stellar/stellar-sdk` (pinned `16.2.0`) — `contract.AssembledTransaction`, `Operation`, `xdr` for the CT invoke glue.
- `zod` (^3.24) — declared as a dependency for upcoming schema-validation work; not yet used in source as of this bootstrap commit.
- Consumed by: every later package in this monorepo (`app`, `api`) that needs testnet network/contract config, including the CT (confidential token) addresses in `TESTNET.ct`, plus `scripts/smoke-ct.ts` and the Task 11 browser CT rail for `buildCtInvokeTx`.

## Gotchas & invariants

- `TESTNET` is `as const` — do not widen it to a mutable type; downstream code relies on literal string/number types (e.g. for exhaustive contract-address checks).
- Contract addresses here are testnet-only and were fixed at bootstrap time; if a contract is redeployed, this is the single file to update (`config.ts`), not call sites.
- `index.ts` re-exports use explicit `.js` extensions (`from "./config.js"`) — required because the package is ESM (`"type": "module"`) with `verbatimModuleSyntax` on; omitting the extension breaks Node's runtime resolution of the compiled output even though the source file is `.ts`.

## Testing

- `pnpm --filter @privacy-wallet/shared test` (`vitest run`) — 7 offline tests in `src/ct-tx.test.ts` covering the CT invoke glue (arg-encoding round-trip, built-op shape, auth-entry surfacing, simulation-failure propagation). No network: `rpc.Server`'s account lookup and simulation are stubbed. Verified passing.
- `TESTNET` itself has no tests — it is a static `as const` object; its contract addresses are validated on-chain by `scripts/smoke-ct.ts` (see [`ct-tx.md`](ct-tx.md)).
