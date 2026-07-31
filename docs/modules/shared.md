# Shared Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `packages/shared/` · **Last verified:** 2026-07-31

## Purpose

Cross-package config and constants for the privacy-wallet monorepo, published as `@grantfox/shared`. Every other package (`app`, `api`, and any later `packages/*`) imports network config, contract addresses, and shared types from here instead of hardcoding them — so a testnet/mainnet or contract-redeploy change happens in one place.

## Structure

| File | Purpose |
|---|---|
| `packages/shared/src/config.ts` | `TESTNET` config object — RPC/Horizon URLs, network passphrase, smart-account and SPP (Selective Privacy Pool) contract addresses. |
| `packages/shared/src/index.ts` | Public entry point; re-exports `TESTNET`. |
| `packages/shared/tsconfig.json` | Extends root `tsconfig.base.json`; emits to `dist/`. |
| `packages/shared/package.json` | Package manifest: build (`tsc -p tsconfig.json`), test (`vitest run`). |

## Endpoints / Public surface

- `TESTNET` (`packages/shared/src/config.ts:1`) — `as const` object with:
  - `rpcUrl`, `horizonUrl`, `networkPassphrase`, `nativeSac`
  - `smartAccount.{accountWasmHash, webauthnVerifierAddress, ed25519VerifierAddress, relayerUrl}`
  - `spp.{pool, publicKeyRegistry, aspMembership, aspNonMembership, deploymentLedger, nethermindBootnode}`

## Key methods

- N/A — this module currently exports only the `TESTNET` config constant, no functions yet.

## Dependencies

- `zod` (^3.24) — declared as a dependency for upcoming schema-validation work; not yet used in source as of this bootstrap commit.
- Consumed by: every later package in this monorepo (`app`, `api`) that needs testnet network/contract config. CT (confidential token) addresses join `TESTNET` in a later task.

## Gotchas & invariants

- `TESTNET` is `as const` — do not widen it to a mutable type; downstream code relies on literal string/number types (e.g. for exhaustive contract-address checks).
- Contract addresses here are testnet-only and were fixed at bootstrap time; if a contract is redeployed, this is the single file to update (`config.ts`), not call sites.
- `index.ts` re-exports use explicit `.js` extensions (`from "./config.js"`) — required because the package is ESM (`"type": "module"`) with `verbatimModuleSyntax` on; omitting the extension breaks Node's runtime resolution of the compiled output even though the source file is `.ts`.

## Testing

- No tests yet — this bootstrap task only ships the config object. `vitest run` is wired as the `test` script; first tests land when the module gains actual logic (e.g. validation) beyond a static constant.
