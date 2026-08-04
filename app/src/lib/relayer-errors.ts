/**
 * User-facing copy for `smart-account-kit`'s `RelayerErrorCodes`
 * (`RelayerErrorCodes` export, `resources/smart-account-kit/src/relayer.ts:59`
 * — `INVALID_PARAMS`/`INVALID_XDR`/`POOL_CAPACITY`/`SIMULATION_FAILED`/
 * `ONCHAIN_FAILED`/`INVALID_TIME_BOUNDS`/`FEE_LIMIT_EXCEEDED`/`UNAUTHORIZED`,
 * plus the client's own `"TIMEOUT"` catch-clause case).
 *
 * The relayer path is shared by every fee-sponsored submission in this app —
 * CT contract calls (`ct.ts`'s `invoke()`), SPP pool writes (`spp-signer.ts`'s
 * `executeTransaction`), and passkey wallet deploy
 * (`providers/WalletProvider.tsx`'s `assertDeployed`) — all go through
 * `kit.signAndSubmit`/`kit.createWallet`, which route through
 * `TESTNET.smartAccount.relayerUrl` when configured (`kit.ts`).
 *
 * **Why match on message TEXT instead of the structured error code:**
 * `smart-account-kit@0.4.2`'s own submission path
 * (`node_modules/.pnpm/smart-account-kit@0.4.2.../dist/kit/tx-ops.js`'s
 * `sendAndPoll`, relayer branch — verified by reading the installed dist,
 * source not vendored in this repo) calls
 * `submissionFailure(relayerResult.error ?? "Relayer submission failed")`,
 * forwarding only the STRING `relayerResult.error` — the structured
 * `RelayerResponse.errorCode` (`relayer.ts`'s `extractErrorCode`) is computed
 * but never passed along, so it never reaches `TransactionFailure.error`.
 * `RelayerClient.extractErrorMessage` (same file) falls back to returning the
 * bare code string itself when the relayer proxy's JSON body has no separate
 * `message` field — the common shape for a proxy error body like
 * `{success:false, error:"FEE_LIMIT_EXCEEDED"}` — so the code often survives
 * as the literal message text anyway. Matching against it here recovers what
 * the kit's own wiring drops, without patching a vendored dependency.
 */
import { RelayerErrorCodes } from "smart-account-kit";

const RELAYER_CODE_COPY: Record<string, string> = {
  [RelayerErrorCodes.INVALID_PARAMS]:
    "The relayer rejected this transaction's parameters — this looks like a bug, please try again or report it.",
  [RelayerErrorCodes.INVALID_XDR]: "The relayer couldn't read this transaction. Please try again.",
  [RelayerErrorCodes.POOL_CAPACITY]:
    "The fee-sponsoring relayer is busy right now (all channel accounts are in use) — try again in a few seconds.",
  [RelayerErrorCodes.SIMULATION_FAILED]:
    "This transaction failed simulation before it reached the network, so nothing was submitted. Check your balance and inputs.",
  [RelayerErrorCodes.ONCHAIN_FAILED]: "This transaction was submitted but failed on-chain.",
  [RelayerErrorCodes.INVALID_TIME_BOUNDS]:
    "This transaction expired before it could be submitted. Please try again.",
  [RelayerErrorCodes.FEE_LIMIT_EXCEEDED]:
    "The app's free daily fee-sponsoring quota has been used up for now. Please try again later.",
  [RelayerErrorCodes.UNAUTHORIZED]: "The relayer rejected this request. Please try again or contact support.",
};

/** Literal, already-readable messages the relayer client constructs itself (not proxy JSON) — matched verbatim. */
const RELAYER_MESSAGE_COPY: Record<string, string> = {
  "Relayer request timed out": "The relayer took too long to respond. Please try again.",
};

/**
 * Match a raw error message against a known relayer failure, either exactly
 * (the common case — see module doc) or as a substring (in case the proxy
 * ever wraps the code in extra text). Returns `null` when nothing matches, so
 * callers can fall back to the original message.
 */
export function humanizeRelayerError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed in RELAYER_MESSAGE_COPY) return RELAYER_MESSAGE_COPY[trimmed] ?? null;
  if (trimmed in RELAYER_CODE_COPY) return RELAYER_CODE_COPY[trimmed] ?? null;
  const matchedCode = Object.keys(RELAYER_CODE_COPY).find((code) => trimmed.includes(code));
  return (matchedCode ? RELAYER_CODE_COPY[matchedCode] : undefined) ?? null;
}
