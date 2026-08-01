/**
 * Task 8.5's backfill loader: writes the committed fixture's rows into the
 * `events` table (idempotently) and initializes the worker's SPP stream
 * cursor straight to RPC mode — so the worker NEVER calls Nethermind's dead
 * bootnode (`-32602 unsupported filters` on every filter set tried, see
 * `poller.ts`'s "Live-verification blocker" gotcha in `docs/modules/api.md`)
 * on its first poll after this backfill lands.
 *
 * `SPP_STREAM_KEY` MUST exactly match the stream key `api/src/worker.ts`'s
 * (unexported) `buildStreamStates()` computes: `` `spp:${sppContractIds.join(",")}` ``
 * where `sppContractIds = [TESTNET.spp.pool, TESTNET.spp.publicKeyRegistry]`
 * (worker.ts:107-108, read directly rather than guessed — see the task-8.5
 * brief's "read api/src/worker.ts for the exact spp: stream key string
 * used"). It is replicated here, NOT imported, because `buildStreamStates`
 * isn't exported. If worker.ts's SPP `contractIds` list ever changes, this
 * constant must change with it, or `initSppCursor` silently targets the
 * wrong cursor row and the worker falls right back to the dead bootnode on
 * its next poll — this is the single biggest correctness risk in this file,
 * flagged in the task-8.5 report.
 *
 * Note: the backfill itself (`backfill-spp.ts`) fetches all FOUR SPP
 * contracts (the SDK's full `all_contract_ids()` sync set — 2 pools +
 * asp_membership + public_key_registry, per the brief), but the worker's
 * live SPP stream (Task 7, unchanged by this task) currently only tracks
 * TWO of them (`pool` + `publicKeyRegistry`) going forward via RPC. The
 * other two contracts' backfilled history still lands in `events` (for
 * Task 9's future bootnode to serve the SDK's full sync set from), it just
 * isn't polled live yet — a gap for a future task, not this one, to close.
 */
import { TESTNET } from "@grantfox/shared";
import type { RepoOps } from "../db/repo.js";
import type { NewEventRow } from "../db/schema.js";
import { encodeRpcModeLedgerCursor, isRpcModeCursor } from "../modules/indexer/poller.js";

/** See module doc — replicated from `api/src/worker.ts`'s `buildStreamStates()`, not imported (not exported there). */
export const SPP_STREAM_KEY = `spp:${[TESTNET.spp.pool, TESTNET.spp.publicKeyRegistry].join(",")}`;

type CursorRepo = Pick<RepoOps, "getCursor" | "setCursor">;
type EventsRepo = Pick<RepoOps, "insertEvents">;

export interface SppCursorInitResult {
  initialized: boolean;
  cursor: string | null;
  reason: "no-existing-cursor" | "existing-cursor-still-bootnode-mode" | "already-rpc-mode";
}

/**
 * Initialize `streamKey`'s cursor to RPC mode at `lastBackfilledLedger + 1`
 * — IFF no cursor exists yet, or the existing one is still in bootnode mode
 * (`null`, a bare bootnode resume token, or a `handoff:...` marker — see
 * `poller.ts`'s module doc for the cursor state machine). Never overwrites
 * an already-`rpc:`-mode cursor: a real handoff (or a prior run of this
 * loader) may have already made progress, and re-running the backfill must
 * not regress it backwards.
 */
export async function initSppCursor(
  repo: CursorRepo,
  streamKey: string,
  lastBackfilledLedger: number,
): Promise<SppCursorInitResult> {
  const existing = await repo.getCursor(streamKey);
  if (existing !== null && isRpcModeCursor(existing)) {
    return { initialized: false, cursor: existing, reason: "already-rpc-mode" };
  }

  const cursor = encodeRpcModeLedgerCursor(lastBackfilledLedger + 1);
  await repo.setCursor(streamKey, cursor);
  return {
    initialized: true,
    cursor,
    reason: existing === null ? "no-existing-cursor" : "existing-cursor-still-bootnode-mode",
  };
}

/**
 * Batch-insert backfilled rows via `repo.insertEvents` (on-conflict-do-nothing
 * by `id`, so idempotent re-runs never duplicate), chunked to keep each
 * individual INSERT reasonably sized. Returns the number of rows submitted
 * (not necessarily the number actually newly inserted — `insertEvents`
 * doesn't report that; the loader script re-queries `count(*)` for the
 * real per-contract report).
 */
export async function loadBackfillEvents(repo: EventsRepo, rows: NewEventRow[], chunkSize = 500): Promise<number> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await repo.insertEvents(rows.slice(i, i + chunkSize));
  }
  return rows.length;
}
