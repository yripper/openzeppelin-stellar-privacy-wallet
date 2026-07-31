# CT Invoke Glue + C-Address Lifecycle Smoke

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `packages/shared/src/ct-tx.ts` + `scripts/smoke-ct.ts` · **Last verified:** 2026-07-31

## Purpose

Everything needed to drive the Confidential Token (CT) contracts when the holder is an OpenZeppelin **smart-account C-address** rather than a plain G-address.

`@ctd/sdk`'s own `ChainClient.invoke` assumes the transaction source *is* the sole auth principal (`packages/ctd-sdk/src/chain/client.ts:143-147`), which is only true for keypair holders. Our wallet's holder is a contract: the fee payer and the auth principal are different parties, and the C-address auth entries must be signed out-of-band as a smart-account `AuthPayload` before the transaction is assembled.

This module is the seam for that split:

- **`buildCtInvokeTx`** — builds and simulates a `contract.AssembledTransaction` for an arbitrary CT call, leaving the recorded auth entries unsigned. Consumed by the Node smoke (manual ed25519 auth-entry signing) and by the browser CT rail (Task 11), which hands the same object to `SmartAccountKit.signAndSubmit`.
- **`scripts/smoke-ct.ts`** — Gate #1: the full CT lifecycle from a freshly deployed C-address on testnet, asserting on-chain state at every step.

## Structure

| File | Purpose |
|---|---|
| `packages/shared/src/ct-tx.ts` | `buildCtInvokeOp` (pure op builder) + `buildCtInvokeTx` (build → simulate). Exported from the `@grantfox/shared` barrel. |
| `packages/shared/src/ct-tx.test.ts` | Offline vitest suite (7 tests): arg-encoding round-trip + the full build/simulate/assemble path against a stubbed `rpc.Server`. |
| `scripts/smoke-ct.ts` | Gate #1 end-to-end script. Run with `pnpm smoke:ct` (= `tsx scripts/smoke-ct.ts`). |

## Public surface

- `CtInvokeConfig` (`packages/shared/src/ct-tx.ts:24`) — `{ rpcUrl, networkPassphrase, source }`; `source` is the **fee-paying G-address**, not the CT holder.
- `buildCtInvokeOp(contractId, method, args): xdr.Operation` (`packages/shared/src/ct-tx.ts:38`) — pure `Operation.invokeContractFunction` wrapper; network-free, unit-testable.
- `buildCtInvokeTx(cfg, contractId, method, args): Promise<contract.AssembledTransaction<unknown>>` (`packages/shared/src/ct-tx.ts:65`) — **the signature later tasks import.** Returns a *simulated* transaction: `tx.built` is the assembled envelope, `tx.simulationData.result.auth` holds the still-unsigned auth entries.

## Key methods (`scripts/smoke-ct.ts`)

- `addressCredentials(entry)` (`:113`) — pulls `SorobanAddressCredentials` out of an entry, handling legacy v1 and CAP-71 v2; returns `null` for source-account credentials.
- `authPayloadScVal(contextRuleIds, signer, signature)` (`:136`) — hand-rolled `AuthPayload` ScVal, `{ context_rule_ids: Vec<u32>, signers: Map<Signer, Bytes> }`, using the kit's exported `signerToScVal` for the map key.
- `countAuthContexts(entry)` (`:176`) — depth-first count of root + sub-invocations. Drives the `context_rule_ids` length (see Gotchas).
- `signAuthEntries(entries, auth, expirationLedger)` (`:190`) — clones each entry, signs the ones addressed to the C-address, returns the patched set plus how many were signed (0 is a hard failure — it means the call never exercised the smart account).
- `invokeAsSmartAccount(feeKp, auth, method, args)` (`:223`) — `buildCtInvokeTx` → sign auth entries → `resimulateAndAssemble` (kit) → fee-payer signature → submit → poll.
- `deploySmartAccount(feeKp, signer)` (`:290`) — bindings `Client.deploy({signers,policies}, {wasmHash, salt, publicKey, signTransaction})`.
- `assertDefaultContextRule(cAddress, signer)` (`:319`) — reads `get_context_rule(0)` on-chain and asserts it is `Default` and contains our External signer, instead of assuming the id.
- `publicBalance(client, address)` (`:344`) — underlying-SAC balance, used to assert deposit/withdraw actually moved public funds.

## The auth-entry signing recipe (what actually works)

Per CT call whose holder is the C-address:

1. `buildCtInvokeTx({ rpcUrl, networkPassphrase, source: feePayer }, token, method, args)` — simulate with the auth entries recorded but unsigned.
2. `expirationLedger = latestLedger + 120`.
3. For each entry whose credential address equals the C-address:
   - `contextRuleIds = Array(countAuthContexts(entry)).fill(0)` — **one id per auth context**.
   - `computeEntryAuthDigest(networkPassphrase, entry, expirationLedger, contextRuleIds)` (smart-account-kit). This also writes the normalized expiration into the entry, so the digest and the submitted `signatureExpirationLedger` agree by construction.
   - `Ed25519Signer.signAuthDigest(authDigest)` → 64-byte signature.
   - `credentials.signature(authPayloadScVal(contextRuleIds, signer, signature))`.
4. `resimulateAndAssemble({rpc, networkPassphrase, timeoutInSeconds}, feeAccount, op.func, signedEntries)` — re-simulation with signatures present is what makes the host charge for the real `__check_auth` work; skipping it underfunds the resource fee.
5. Sign the envelope with the fee keypair, `sendTransaction`, `pollTransaction`.

## Gate outcome — PASSED

Gate #1 ran green on testnet on 2026-07-31 with the full C-address path (no fallback taken). Transcript of the passing run:

```
token   = CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH
[accounts]  fee payer GBKZJAGVLJBSB35KWTKSBXXJCVS2AWDI3ZWEPO5PCU3AZPU6ZNBAY5NJ · bob GBRAOYRIYBS55SZNDA4PY5L3ZRIWMM5KQ5RWBNNMYI4UBCVZJFBS56OP
[smart account] deployed = CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II
  context rule 0 = Default, signer installed ✓ · friendbot-funded, public SAC balance = 100000000000 stroops
[register]  C registered  tx 38d98eb08338890b3c5724f4663bb2a436451b68fbb309c7e042cece4cca6731
            bob registered tx 0f991eab9d5feb93f2c44d4eb38cebae7306f927c57775a67fee9cbae5753e21
[deposit]   tx 2af0fc9b44a3cfd95d18ec6d7b4ce0d472385755f79d80a6692ec3b86db32d7e
[merge]     tx d96246f5f752c23c32241049d3a7c27fc39dcb74e7df0840fce28ae42a0ff2a1
            C spendable = 1000000000 (public balance debited, state matches chain ✓)
[transfer]  tx 83f685f5b597fa1bb2f6648a2017d7e81625097fb0f3a81d9654992850079a85
            C spendable = 600000000 ✓ · bob receiving = 400000000 (ECDH-decrypted from event ✓)
[withdraw]  tx 03fff0ec505ceba287c314f9ffe0e9d9f55c8699aeb58c24d74a4508ff8e5c02
            C spendable = 0, public balance credited ✓
[bob]       merge → spendable = 400000000 ✓
✅ gate #1 passed — full CT lifecycle from a C-address smart account.
```

What this proves: smart-account `__check_auth` accepts our hand-built `AuthPayload` for `register`, `deposit` (2 contexts), `merge`, `confidential_transfer` and `withdraw`; the UltraHonk proofs verify on-chain under C-address auth; the local `StateEngine` openings re-commit to the exact on-chain points at every step; and public SAC funds move in and out of the confidential balance as expected.

## Dependencies

- `@stellar/stellar-sdk` 16.2.0 — `contract.AssembledTransaction`, `Operation.invokeContractFunction`, `rpc.Server`.
- `smart-account-kit` 0.4.2 — `Ed25519Signer`, `computeEntryAuthDigest`, `signerToScVal`, `resimulateAndAssemble` (smoke only).
- `smart-account-kit-bindings` 0.3.0 — `Client.deploy`, `get_context_rule` (smoke only).
- `@ctd/sdk` (workspace) — witness builders, `CircuitProver`, `loadCircuit` (via the `@ctd/sdk/proving/artifacts` subpath), payload encoders, `ChainClient`, `StateEngine` (smoke only).
- `@grantfox/shared` — `TESTNET` config.
- Root `pnpm.overrides` pins `@stellar/stellar-sdk` to `16.2.0` workspace-wide, because `smart-account-kit@0.4.2` depends on `16.0.1` directly. Two copies would mean two `xdr` class identities across the auth-entry handoff — see Gotchas.

## Gotchas & invariants

- **`context_rule_ids` is one id per auth context, not one per entry.** `do_check_auth` panics with `ContextRuleIdsLengthMismatch` (contract error 3014) unless `context_rule_ids.len() == auth_contexts.len()`, and the ids are positionally aligned with the contexts (`resources/stellar-contracts` `packages/accounts/src/smart_account/storage.rs:468-480`). A `deposit` produces **two** contexts — the CT `deposit` plus the underlying SAC `transfer` the token re-enters on the holder's behalf — so its payload needs `[0, 0]`. This was the one real blocker hit during the gate; `register` and `merge` (single context) worked on the first attempt.
- **`addr_f` is the TOKEN contract's address-as-field, not the holder's.** The task brief's `addressToField(cAddress)` would produce keys the contract rejects: `storage.rs` supplies its own stored `AddressAsField` as a public input when verifying (`packages/ctd-sdk/src/crypto/address.ts:10-12`, mirrored by `resources/stellar-confidential-token-demo/scripts/e2e.ts:58`). The smoke uses `addressToField(TESTNET.ct.token)` and asserts it equals `TESTNET.ct.addrF`.
- **The Default context rule is id 0** because `add_context_rule` reads its counter with `unwrap_or(0u32)` (`stellar-contracts` `smart_account/storage.rs:634`) and `__constructor` creates exactly one rule. The smoke still verifies it on-chain rather than trusting the constant.
- **`computeEntryAuthDigest` mutates the entry it is handed** (it writes `signatureExpirationLedger`). Always pass the clone you are about to submit, never the simulation's entry — and never recompute the expiration between digest and submission, or `__check_auth` sees a different preimage.
- **Re-simulate after signing.** The first simulation prices an entry whose signature is `void`; the real `__check_auth` (verifier cross-contract call + ed25519 verify) costs more. `resimulateAndAssemble` re-prices and re-assembles.
- **`register` is one-shot per address.** The smoke deploys a *fresh* smart account every run; re-running against a fixed C-address fails with `AccountAlreadyRegistered`.
- **Friendbot funds C-addresses.** `rpc.Server.fundAddress` (stellar-sdk ≥ 14.5) accepts both `G…` and `C…`; for a contract it lands as a native-SAC balance, which is exactly what `deposit` spends. 10,000 XLM per call on testnet.
- **`buildCtInvokeTx` does not throw on a failed simulation.** It follows `AssembledTransaction` semantics: the error surfaces when `tx.simulationData` (or `.result`) is read, as `AssembledTransaction.Errors.SimulationFailed`. Callers that want early failure must read `simulationData` themselves.
- `source` in `CtInvokeConfig` is the **fee payer**, not the CT holder. Passing the C-address there would fail — a contract has no account entry to load a sequence number from.
- `allowHttp` is derived from the URL scheme (`http://` → true), mirroring `ChainClient`; there is no config knob, so a plaintext non-localhost RPC is still opt-in by URL only.

## Testing

- `pnpm --filter @grantfox/shared test` — 7 offline vitest tests, no network. Covers the ScVal round-trip through the invoke op (address/u32/i128/bytes/map, ordering, empty args, non-contract-address rejection) and the full `buildCtInvokeTx` path against a stubbed `rpc.Server` (source account, built op, auth entries surfaced unsigned, simulation-failure propagation). Verified passing.
- `pnpm smoke:ct` (or `pnpm exec tsx scripts/smoke-ct.ts`) — Gate #1 on testnet. Needs network, spends ~1 XLM of fees from throwaway friendbot accounts, and takes ~3 minutes (three UltraHonk proofs + 8 transactions). Verified passing; transcript above.
