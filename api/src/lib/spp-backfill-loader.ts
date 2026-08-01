/**
 * Task 8.5's backfill loader: writes the committed fixture's rows into the
 * `events` table (idempotently) and initializes the worker's SPP stream
 * cursor straight to RPC mode — so the worker NEVER calls Nethermind's dead
 * bootnode (`-32602 unsupported filters` on every filter set tried, see
 * `poller.ts`'s "Live-verification blocker" gotcha in `docs/modules/api.md`)
 * on its first poll after this backfill lands.
 *
 * `SPP_STREAM_KEY` MUST exactly match the stream key `api/src/worker.ts`'s
 * `buildStreamStates()` computes for the SPP stream. Task 8.5 replicated
 * that computation by hand here (`` `spp:${[TESTNET.spp.pool, TESTNET.spp.publicKeyRegistry].join(",")}` ``)
 * because `buildStreamStates` wasn't exported, and flagged the drift risk:
 * "if worker.ts's SPP contractIds list ever changes... SPP_STREAM_KEY must
 * be updated in lockstep." Task 9 does exactly that (2 -> 4 contracts, see
 * `worker.ts`'s `buildSppContractIds` doc comment) and closes the risk at
 * the root: `SPP_STREAM_KEY` now IMPORTS `buildSppStreamKey()` from
 * `worker.ts` instead of re-deriving it, so the two files can never drift
 * again. (`worker.ts` is safe to import here — its `main()` auto-run is
 * guarded by an `import.meta.url === pathToFileURL(process.argv[1]).href`
 * check, so importing it from a script whose entrypoint is NOT `worker.ts`
 * never triggers the worker process loop.)
 *
 * Note: the backfill itself (`backfill-spp.ts`) fetches all FOUR SPP
 * contracts (the SDK's full `all_contract_ids()` sync set — 2 pools +
 * asp_membership + public_key_registry, per the brief); as of Task 9 the
 * worker's live SPP stream now tracks all four too (previously only 2 of 4
 * were polled live — see `worker.ts`'s `buildSppContractIds` doc comment).
 */
import type { RepoOps } from "../db/repo.js";
import type { NewEventRow } from "../db/schema.js";
import { encodeRpcModeLedgerCursor, isRpcModeCursor } from "../modules/indexer/poller.js";
import { buildSppStreamKey } from "../worker.js";

/** Imported from `worker.ts` (Task 9) — see module doc. */
export const SPP_STREAM_KEY = buildSppStreamKey();

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
