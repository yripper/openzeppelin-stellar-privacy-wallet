/**
 * User-facing humanization for the Confidential Token (CT) rail's
 * `smart-account-kit` `TransactionFailure.error` — the shape every
 * `kit.signAndSubmit` call in `ct.ts`'s `invoke()` can fail with (register,
 * deposit, merge, transfer, withdraw all share this one chokepoint).
 *
 * Two layers, tried in order:
 *  1. `@ctd/sdk`'s own `humanizeContractError`
 *     (`packages/ctd-sdk/src/chain/errors.ts:61`) — the confidential-token +
 *     compliance contracts' error table (codes 2000-3603).
 *     `smart-account-kit`'s OWN `decodeContractError`
 *     (`node_modules/.../smart-account-kit/dist/contract-errors.d.ts`) only
 *     knows ITS OWN deployed contracts' codes (SmartAccount/WebAuthn/
 *     Threshold/SpendingLimit, 3000-3227 — verified no overlap with the CT
 *     range), so a CT contract failure reaches `ct.ts` as a raw, undecoded
 *     `SubmissionError`/`SimulationError` whose `.message` still embeds the
 *     `Error(Contract, #NNNN)` marker `humanizeContractError` parses.
 *  2. `./relayer-errors.js`'s `humanizeRelayerError` — see that module's doc
 *     for why matching raw message TEXT (not a structured error code) is the
 *     only channel left once `smart-account-kit`'s relayer branch has run.
 *
 * Falls back to the original message when neither matches — most
 * SmartAccount-family contract failures are ALREADY humanized by the kit's
 * own `ContractError.message` by the time they reach here, and an unknown
 * numeric code still gets `humanizeContractError`'s generic "error #N"
 * fallback rather than a raw multi-line HostError diagnostic dump.
 *
 * Deliberately not imported from `spp.ts`/`Shielded.tsx`/`WalletProvider.tsx`
 * — those call sites use `./relayer-errors.js` directly instead. **This is
 * import-hygiene, not a bundle-size optimization**: the app has no route/tab
 * code-splitting (`App.tsx` and `Shell.tsx` both statically import every
 * page/tab, no `lazy()` anywhere), so `@ctd/sdk`'s JS module graph has been
 * unconditionally reachable from the single entry chunk since Task 11
 * regardless of whether this file is imported — verified against a real
 * `vite build`: `dist/assets/index-*.js` is one chunk containing every
 * route. The real reason non-CT call sites use `relayer-errors.js` instead
 * is that importing a CT-specific module from SPP/wallet-lifecycle code
 * would be a backwards dependency (those rails have no reason to know CT
 * contract codes exist), not that it changes what ships. bb.js's actual
 * 3.4MB WASM stays out of the JS bundle via an unrelated mechanism —
 * `bb-loader.ts`'s `ensureBrowserBackend()` loads it through a RUNTIME
 * dynamic `import(/* @vite-ignore *\/ "/vendor/bb/index.js")` against a
 * vendored `/public` asset, which Vite never bundles regardless of which
 * app code imports from `@ctd/sdk`.
 */
import { humanizeContractError } from "@ctd/sdk";

import { humanizeRelayerError } from "./relayer-errors.js";

function rawMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Translate a raw CT-rail error (Error, string, or anything else) into copy a wallet user can act on. */
export function humanizeError(err: unknown): string {
  const raw = rawMessage(err).trim();
  if (!raw) return "Something went wrong. Please try again.";
  return humanizeContractError(raw) ?? humanizeRelayerError(raw) ?? raw;
}
