/**
 * Local log of this wallet's SPP "boundary" events — shield (public XLM into
 * the pool) and unshield (pool back to public XLM), the two SPP actions where
 * money crosses the public/private line and is therefore visible on-ledger by
 * construction. Shielded transfers between two pool participants are NEVER
 * recorded here — staying unrecorded (not just unamount) is the point.
 *
 * ## Why this is recorded locally by the app, not read back from chain/SDK state
 *
 * Verified against `resources/stellar-private-payments` (vendored reference
 * only, not part of this repo's buildable tree — same "scratch reference"
 * status as `resources/stellar-confidential-token-demo/`, see
 * `docs/modules/ctd-sdk.md`'s "Vendoring" section):
 *
 *  - The pool contract's OWN on-chain events carry no plaintext amount or
 *    address at all, for shield/send/unshield alike —
 *    `contracts/pool/src/pool.rs` publishes only
 *    `NewCommitmentEvent{commitment, index, encrypted_output}` and
 *    `NewNullifierEvent{nullifier}` (both opaque without the recipient's own
 *    private viewing key). There is no separate on-chain "deposit"/"withdraw"
 *    event to decode client-side, despite privacy-pool designs elsewhere
 *    sometimes exposing one.
 *  - Our own indexer only tracks the 4 SPP-specific contracts
 *    (`api/src/worker.ts`'s `buildSppContractIds()`), not the native XLM SAC
 *    — so even the underlying token transfer a shield/unshield performs isn't
 *    in our `events` table to filter by session address.
 *  - The browser SDK's own local note storage (`account.userNotes()`/
 *    `pool.notes()`, already used by `spp.ts`'s `SppRail.refresh()`) has no
 *    per-note "origin type" field distinguishing a shield-in note from a
 *    received-private-transfer note — both are just a spendable commitment,
 *    by design (`sdk/types/src/lib.rs`'s `UserNoteSummary`).
 *  - The SDK DOES define a per-user operation-history table shaped exactly
 *    for this (`sdk/types/src/lib.rs`'s `UserOperation` — op_type / amount /
 *    direction / counterparty / tx_hash / created_at — written via
 *    `Storage::insert_operation`, read via `Storage::list_operations`), but
 *    in this vendored version (`stellar-private-payments@0.1.0-alpha.1`) it
 *    is reachable only from the SDK's own CLI (`cli/src/cmd/feed.rs`) — the
 *    wasm/JS surface (`sdk/web/js/index.js`'s `wrapClient`/`wrapAccount`) has
 *    no `recordOperation`/`listOperations` method, so a browser client
 *    (this app) cannot call it.
 *
 * So the simplest HONEST option — the one every wallet resorts to for
 * "recent activity" absent a purpose-built indexer for it — is to record the
 * outcome ourselves, client-side, at the moment our own app performs the
 * action: `Shielded.tsx` calls {@link recordSppBoundaryEvent} right after a
 * successful shield/unshield, using the exact amount/hashes it already has in
 * hand from the SDK's own execute result. This is necessarily local-only
 * (lost if the browser's storage is cleared) and starts empty on a new
 * device — a real, documented limitation, not silently glossed over.
 */
import { get, set } from "idb-keyval";

export type SppBoundaryEventType = "shield" | "unshield";

export interface SppBoundaryEvent {
  id: string;
  type: SppBoundaryEventType;
  /** Stroops, as a decimal string (never a float — same convention as `format.ts`'s stroop helpers). */
  amount: string;
  hashes: string[];
  /** ISO-8601, client clock at the moment the action was recorded (see module doc: no chain timestamp is available for this). */
  createdAt: string;
}

const MAX_ENTRIES = 200;

function storageKey(sessionAddress: string): string {
  return `grantfox:spp-boundary:${sessionAddress}`;
}

/** Append one boundary event for `sessionAddress`, newest-first, capped at {@link MAX_ENTRIES}. */
export async function recordSppBoundaryEvent(
  sessionAddress: string,
  event: Omit<SppBoundaryEvent, "id" | "createdAt">
): Promise<void> {
  const key = storageKey(sessionAddress);
  const existing = (await get<SppBoundaryEvent[]>(key)) ?? [];
  const entry: SppBoundaryEvent = {
    ...event,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  await set(key, [entry, ...existing].slice(0, MAX_ENTRIES));
}

/** Read `sessionAddress`'s boundary log, newest-first. Empty array (never `undefined`) when nothing has been recorded yet. */
export async function listSppBoundaryEvents(sessionAddress: string): Promise<SppBoundaryEvent[]> {
  return (await get<SppBoundaryEvent[]>(storageKey(sessionAddress))) ?? [];
}
