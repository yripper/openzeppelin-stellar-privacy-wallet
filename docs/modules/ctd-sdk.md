# ctd-sdk Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `packages/ctd-sdk/` · **Last verified:** 2026-07-31 (added the `./proving/artifacts` subpath export)

## Purpose

Client SDK for the Stellar Confidential Token demo, published as `@ctd/sdk`. It builds Noir circuit witnesses, generates/verifies UltraHonk zero-knowledge proofs, encodes the `{payload, proof}` XDR envelopes the confidential-token Soroban contracts expect, talks to the chain over RPC, and reconstructs client-side balances from chain events. Tasks 4 and 11 in this monorepo's plan depend directly on its witness/proving/encoding exports for Confidential Token flows.

This package is **vendored, not authored here** — see [Vendoring](#vendoring) below. Treat upstream `src/`, `circuits/`, `contracts/`, `test/` as third-party code: don't refactor it beyond what's required to keep it building against this monorepo's pinned dependencies.

## Vendoring

- Copied from `brozorec/stellar-confidential-token-demo` (upstream commit `ac67499a617c084b80c0e0298180b2c4faf9e2fb`), path `packages/sdk`. Full provenance and the running list of local modifications: `packages/ctd-sdk/ATTRIBUTION.md`.
- The upstream repo itself lives at `resources/stellar-confidential-token-demo/` in this checkout but is **gitignored** (scratch reference only) — `packages/ctd-sdk/` is the tracked, buildable copy.
- Local modifications so far (authoritative list: `packages/ctd-sdk/ATTRIBUTION.md`), both `package.json`-only, **zero source changes**:
  1. `@stellar/stellar-sdk` bumped from upstream's `^14.2.0` to this monorepo's pinned `16.2.0`. `tsc -p tsconfig.json` compiled clean; the package's stellar-sdk surface (`Address`, `xdr.ScVal`, `nativeToScVal`, `scValToNative`, `rpc`) is stable across 14→16 for the call sites used here.
  2. Added a `"./proving/artifacts"` subpath export so built-package consumers can reach the Node-only `loadCircuit` (upstream's own scripts get at it by relative source path, which is not available to a workspace dependency).
- Package name is kept as-is (`@ctd/sdk`, not renamed to a `@grantfox/*` scope) so upstream import paths and the vendored tests keep working unmodified. Consumers depend on it via `"@ctd/sdk": "workspace:*"`.

## Structure

| Path | Purpose |
|---|---|
| `packages/ctd-sdk/src/crypto/` | Grumpkin curve (`@noble/curves`) + Poseidon2 (`@zkpassport/poseidon2`), key/address derivation — mirrors the Noir circuits' `lib.nr` exactly. |
| `packages/ctd-sdk/src/witness/` | Per-circuit witness builders: `register.ts`, `withdraw.ts`, `transfer.ts` (plus `disclose-sender.ts`/`disclose-recipient.ts` for selective disclosure). |
| `packages/ctd-sdk/src/proving/` | UltraHonk proving via `@aztec/bb.js` with a keccak transcript (`prover.ts`); Node-only circuit-artifact loading (`artifacts.ts`). |
| `packages/ctd-sdk/src/chain/` | RPC client (`client.ts`), XDR `{payload, proof}` envelope encoding (`payload.ts`), event ingestion (`events.ts`, `event-source.ts` hybrid RPC+indexer), indexer client (`indexer.ts`), admin ops (`admin.ts`), contract op builders (`contract.ts`, `factory.ts`), typed errors (`errors.ts`). |
| `packages/ctd-sdk/src/state/` | `StateEngine` balance reconstruction from events, with pluggable persistence (`store.ts` in-memory, `browser-store.ts` `localStorage`, `json-store.ts` Node-only file store — kept out of the package barrel, see Gotchas). |
| `packages/ctd-sdk/src/auditor/` | Decryption of the dual auditor ciphertexts emitted by transfers. |
| `packages/ctd-sdk/src/disclosure/` | Off-chain selective-disclosure protocol (prove on the holder side, verify on the receiver side). References a sibling `@ctd/disclosure` package in comments only — that package is **not** vendored here; see Gotchas. |
| `packages/ctd-sdk/circuits/*.json` | Compiled ACIR circuits (`register`, `withdraw`, `transfer`) consumed via `loadCircuit()` (Node) or direct bundler import (browser). |
| `packages/ctd-sdk/circuits/vks/*.vk.bin` | Pinned verification keys for the circuits above plus disclosure-related circuits. |
| `packages/ctd-sdk/contracts/*.wasm` | Compiled Soroban contract WASM (token, verifier, auditor, allowlist/blocklist, factory) — deploy artifacts, not imported by `src/`. |
| `packages/ctd-sdk/test/*.mjs` | Plain `tsx`-run scripts, not a test runner. Import TS sources directly from `../src/*.ts`. |
| `packages/ctd-sdk/tsconfig.json` | Extends root `tsconfig.base.json`; `rootDir: src`, `outDir: dist`, excludes `test/`. |
| `packages/ctd-sdk/ATTRIBUTION.md` | Upstream commit hash, license note, and the authoritative running list of local modifications. |

## Public surface (key exports, verified `file:line`)

- `generateKeys(addrF)`, `deriveKeys(sk, addrF)`, `serializeKeys`, `deserializeKeys` — `packages/ctd-sdk/src/crypto/keys.ts:43`, `:35`, `:48`, `:52`
- `addressToField(strkey)` — `packages/ctd-sdk/src/crypto/address.ts:25`
- `buildRegisterWitness(keys)` — `packages/ctd-sdk/src/witness/register.ts:18`
- `buildWithdrawWitness(params)` — `packages/ctd-sdk/src/witness/withdraw.ts:51`
- `buildTransferWitness(params)` — `packages/ctd-sdk/src/witness/transfer.ts:76`
- `CircuitProver` (class), `setUltraHonkBackendLoader(loader)` — `packages/ctd-sdk/src/proving/prover.ts:61`, `:45`
- `encodeRegisterData(w, proof)`, `encodeWithdrawData(w, proof)`, `encodeTransferData(w, proof)` → `xdr.ScVal` — `packages/ctd-sdk/src/chain/payload.ts:48`, `:56`, `:68`
- `ChainClient` (class) — `packages/ctd-sdk/src/chain/client.ts:80`
- `keypairSigner(secret, networkPassphrase)` — `packages/ctd-sdk/src/chain/client.ts:68`
- `StateEngine` (class) — `packages/ctd-sdk/src/state/engine.ts:61`
- `MemoryStore` — `packages/ctd-sdk/src/state/store.ts:53`; `LocalStorageStore` — `packages/ctd-sdk/src/state/browser-store.ts:12`
- `JsonFileStore` (Node-only, not in the barrel) — `packages/ctd-sdk/src/state/json-store.ts:13`, import via the `./state/json-store` package export
- `fetchEvents(...)` — `packages/ctd-sdk/src/chain/events.ts:261`; `hybridFetchEvents(...)` — `packages/ctd-sdk/src/chain/event-source.ts:82`
- `IndexerClient` (class) — `packages/ctd-sdk/src/chain/indexer.ts:61`
- `loadCircuit(name)` (Node only, not in the barrel; reads `circuits/<name>.json` off `import.meta.url`) — `packages/ctd-sdk/src/proving/artifacts.ts:20`, import via the `@ctd/sdk/proving/artifacts` package export

All of the above are re-exported from the package root (`packages/ctd-sdk/src/index.ts:15-21`) via `export * from "./<layer>/index.js"`, **except** two Node-only entries that are deliberately kept out of the browser-safe barrels and reachable only via their own subpath exports (`packages/ctd-sdk/package.json:12-19`): `JsonFileStore` (`@ctd/sdk/state/json-store`) and `loadCircuit` (`@ctd/sdk/proving/artifacts`).

## Dependencies

- `@stellar/stellar-sdk` — pinned `16.2.0` (this monorepo's standard, bumped from upstream's `^14.2.0`).
- `@aztec/bb.js@0.87.0` — UltraHonk backend; fetches the Barretenberg CRS to `~/.bb-crs` on first proof (network required once, then cached; root `.gitignore` excludes `.bb-crs/`).
- `@noir-lang/noir_js@1.0.0-beta.9`, `@noble/curves`, `@noble/hashes`, `@zkpassport/poseidon2` — circuit execution and crypto primitives, unchanged from upstream.
- Consumed by: `scripts/smoke-ct.ts` (gate #1 — witness/proving/encoding + `ChainClient`/`StateEngine`, see `docs/modules/ct-tx.md`) and the Task 11 browser CT rail — via `"@ctd/sdk": "workspace:*"`.

## Gotchas & invariants

- **This is vendored code.** Don't apply this monorepo's usual style/refactor conventions to `src/`, `circuits/`, `contracts/`, `test/` — only touch what's needed to keep it compiling against pinned deps, and log every such change in `packages/ctd-sdk/ATTRIBUTION.md`.
- `JsonFileStore` is deliberately excluded from the root barrel (`src/index.ts`) so the browser bundle never pulls in `node:fs` — import it from the `./state/json-store` subpath, not the package root (`packages/ctd-sdk/src/state/json-store.ts:1-5`).
- `loadCircuit()` is Node-only (`readFileSync` off `import.meta.url`) and is **not** in the `./proving/index.js` barrel (`packages/ctd-sdk/src/proving/index.ts:1-4`) so bundlers never pull `node:fs` into the browser build. Node consumers import it from the `@ctd/sdk/proving/artifacts` subpath (added locally — see `ATTRIBUTION.md`); browser code imports the `circuits/*.json` files directly through its bundler instead (`packages/ctd-sdk/src/proving/artifacts.ts:1-8`).
- The vendored `src/disclosure/*` and its `README.md` reference a sibling `@ctd/disclosure` package (shared circuit + pinned VK for selective disclosure) that is **not** part of this vendored copy — those are inert doc comments, not live imports; nothing in `packages/ctd-sdk` fails to build or run without it, but selective-disclosure proving/verification will need that package vendored separately if a later task needs it.
- `test/*.mjs` import straight from `../src/*.ts` (via `tsx`), not from `dist/` — the tests pass without running `build` first, but consumers importing `@ctd/sdk` as a workspace package need `dist/` (i.e. `pnpm --filter @ctd/sdk build`) since `package.json` exports point at `./dist/index.js`.
- `test/prove.mjs` needs network on first run (CRS fetch to `~/.bb-crs`, ~2 MB); subsequent runs are offline and fast.
- Full `pnpm test` upstream script chains 12 test files including slow real-proof generation (`prove.mjs`, `disclosure.mjs`) and one that needs a deployed indexer (`indexer-parity.mjs`) — this task only validates `parity.mjs` + `prove.mjs`; the rest are unverified here.

## Testing

- `pnpm --filter @ctd/sdk exec tsx test/parity.mjs` — offline witness/circuit parity (7 cases: register, withdraw, transfer, each with a tamper-rejection case). Verified passing.
- `pnpm --filter @ctd/sdk exec tsx test/prove.mjs` — real UltraHonk proof generation + local verification for all three circuits (needs network on first run for the CRS). Verified passing.
- `pnpm --filter @ctd/sdk build` — `tsc -p tsconfig.json`, clean with zero errors post stellar-sdk bump.
- Not run as part of this task (see Gotchas): `smoke.mjs`, `payload.mjs`, `auditor.mjs`, `ephemeral.mjs`, `dedup.mjs`, `compliance-events.mjs`, `contract-errors.mjs`, `indexer-parity.mjs`, `hybrid-indexer-failure.mjs`, `disclosure.mjs`.
