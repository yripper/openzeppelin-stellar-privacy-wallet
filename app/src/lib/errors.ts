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
 * Deliberately kept out of `spp.ts`/`Shielded.tsx`/`WalletProvider.tsx`:
 * importing `@ctd/sdk` (even just for this one function) pulls in its whole
 * barrel, including the bb.js/UltraHonk proving graph
 * (`docs/modules/app.md`'s Task 11 vite gotchas) — those call sites use
 * `./relayer-errors.js` directly instead, since they never touch the CT
 * contract.
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
