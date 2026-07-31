/**
 * The indexer's core polling engine (Task 7). Drives the two `EventsPage`
 * sources from Task 6 (`fetchRpcEvents`, `fetchBootnodeEvents`) against the
 * Task 5 `IndexerRepo`, one page per `pollStream` call.
 *
 * `StreamSource` is the seam that keeps `pollStream` itself generic and
 * protocol-agnostic: it knows nothing about RPC vs. bootnode, retention
 * handoffs, or resume-token formats — it just reads the stream's stored
 * cursor, asks the source for one page, and writes (events + new cursor) as
 * one Postgres transaction. All of the CT/SPP-specific plumbing — including
 * the bootnode→RPC handoff switch — lives in the two `StreamSource`
 * factories below (`makeRpcSource`, `makeBootnodeThenRpcSource`), which
 * `worker.ts` wires up with the real `TESTNET` contract ids and ledgers.
 *
 * Cursor-value encoding (all opaque strings from `pollStream`'s point of
 * view, but meaningful to the two source factories that produce/consume
 * them):
 * - `null` — no progress yet; source should start from its configured
 *   `startLedger`.
 * - a bare string with no recognized prefix — an opaque resume token
 *   from the underlying source (RPC `cursor` / bootnode `cursor`), passed
 *   straight back into the next fetch.
 * - `ledger:<N>` — synthesized by `nextResumeTokenFromPage` when a page
 *   reports `cursor: null` (the source has "no further cursor" per the
 *   `EventsPage.cursor` doc comment, i.e. caught up) but still reports a
 *   `latestLedger` to resume from. Neither `fetchRpcEvents` nor
 *   `fetchBootnodeEvents` accepts a bare ledger number as a `cursor`
 *   argument, so this is OUR marker, decoded back into a `startLedger`
 *   fetch on the next poll — never passed to the network as-is.
 * - `handoff:<fromLedger>` (SPP stream only) — persisted the instant the
 *   bootnode returns a retention-handoff response; the transitional
 *   observable state the task brief asks for. Decoded exactly like
 *   `ledger:<N>` (switch to RPC, `startLedger: fromLedger`), but kept
 *   textually distinct so it is visible in the `cursors` table that a
 *   handoff happened.
 * - `rpc:<...>` (SPP stream only) — once handed off, EVERY subsequent SPP
 *   cursor is written with this prefix (wrapping either a `ledger:<N>` or a
 *   bare RPC cursor). This is what makes the handoff survive a worker
 *   restart: `makeBootnodeThenRpcSource` decides "am I in RPC mode?" purely
 *   from the persisted cursor string, not from any in-memory flag, so a
 *   brand-new `StreamSource` instance reading a `rpc:`-prefixed cursor goes
 *   straight to RPC without re-trying (and being re-rejected by) the
 *   bootnode.
 */
import type { IndexerRepo } from "../../db/repo.js";
import type { NewEventRow } from "../../db/schema.js";
import {
  fetchRpcEvents,
  type EventsPage,
  type FetchRpcEventsOptions,
  type RawEvent,
} from "../../lib/soroban-events.js";
import { fetchBootnodeEvents, type FetchBootnodeEventsOptions } from "../../lib/bootnode-client.js";

/** One page fetch's result, in the shape `pollStream` needs: rows to insert + the cursor to advance to. */
export interface StreamFetchResult {
  events: RawEvent[];
  /** The cursor value to persist for this stream's next poll. `pollStream` always advances to it (see module doc — sources never return a bare `null` here once caught up; they synthesize a `ledger:`/`handoff:` marker instead). */
  nextCursor: string | null;
}

/** A stream's event source, abstracted over RPC vs. bootnode-then-RPC. */
export interface StreamSource {
  /** Fetch one page given the stream's current stored cursor (`null` before the first poll). */
  fetchPage(cursor: string | null): Promise<StreamFetchResult>;
}

function toNewEventRow(e: RawEvent): NewEventRow {
  return {
    id: e.id,
    contractId: e.contractId,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    txHash: e.txHash,
    txIndex: e.txIndex,
    opIndex: e.opIndex,
    eventIndex: e.eventIndex,
    topic: e.topic,
    valueXdr: e.valueXdr,
    inSuccessfulCall: e.inSuccessfulCall,
  };
}

/**
 * Poll one page for one stream: fetch (network I/O, outside any
 * transaction), then batch-insert the events and advance the cursor as ONE
 * Postgres transaction (invariant 1) — a throw from either half rolls back
 * both, via `IndexerRepo.withTransaction`'s existing commit-on-success /
 * rollback-on-throw contract (`api/src/db/repo.ts`, integration-tested by
 * Task 5's `repo.test.ts`). A page with zero events but a non-null
 * `nextCursor` still advances the cursor (invariant 2) — `insertEvents([])`
 * is a documented no-op, `setCursor` still runs.
 */
export async function pollStream(source: StreamSource, repo: IndexerRepo, streamKey: string): Promise<void> {
  const cursor = await repo.getCursor(streamKey);
  const { events, nextCursor } = await source.fetchPage(cursor);

  await repo.withTransaction(async (tx) => {
    await tx.insertEvents(events.map(toNewEventRow));
    if (nextCursor !== null) {
      await tx.setCursor(streamKey, nextCursor);
    }
  });
}

export interface StreamConfig {
  streamKey: string;
  source: StreamSource;
}

export interface StreamPollOutcome {
  streamKey: string;
  ok: boolean;
  error?: unknown;
}

/**
 * Poll every configured stream once, isolating failures (invariant 5): each
 * stream gets its own try/catch, so one throwing doesn't stop the rest from
 * being attempted. Returns a per-stream outcome for the caller (the
 * `worker.ts` loop) to drive backoff bookkeeping / logging.
 *
 * `shouldStop` is checked between iterations (never mid-flight — a stream
 * already in progress always runs to completion/timeout, this only skips
 * streams not yet started) so a shutdown signal can shorten `tick`'s worst
 * case from "every remaining stream's full timeout" to "at most the one
 * currently in flight" without restructuring the sequential loop into
 * concurrent/`Promise.all` execution. A skipped stream is simply absent
 * from the returned outcomes (its backoff state is left untouched by the
 * caller — reasonable given the process is shutting down anyway).
 */
export async function pollStreams(
  streams: StreamConfig[],
  repo: IndexerRepo,
  shouldStop?: () => boolean,
): Promise<StreamPollOutcome[]> {
  const outcomes: StreamPollOutcome[] = [];
  for (const { streamKey, source } of streams) {
    if (shouldStop?.()) break;
    try {
      await pollStream(source, repo, streamKey);
      outcomes.push({ streamKey, ok: true });
    } catch (error) {
      outcomes.push({ streamKey, ok: false, error });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Resume-token codec shared by both source factories (see module doc).
// ---------------------------------------------------------------------------

type ResumeToken = { kind: "cursor"; value: string } | { kind: "ledger"; value: number };

const LEDGER_PREFIX = "ledger:";
const HANDOFF_PREFIX = "handoff:";
const RPC_PREFIX = "rpc:";
const DEFAULT_PAGE_LIMIT = 100;

function encodeResumeToken(token: ResumeToken): string {
  return token.kind === "ledger" ? `${LEDGER_PREFIX}${token.value}` : token.value;
}

function decodeResumeToken(raw: string): ResumeToken {
  if (raw.startsWith(LEDGER_PREFIX)) {
    return { kind: "ledger", value: Number(raw.slice(LEDGER_PREFIX.length)) };
  }
  return { kind: "cursor", value: raw };
}

/** `EventsPage.cursor` is `null` when the source reports "no further cursor" (caught up) — fall back to resuming by ledger number rather than persisting a dead-end `null`. */
function nextResumeTokenFromPage(page: EventsPage): ResumeToken {
  return page.cursor !== null ? { kind: "cursor", value: page.cursor } : { kind: "ledger", value: page.latestLedger + 1 };
}

function resumeTokenToRpcFetchOpts(
  token: ResumeToken | null,
  defaultStartLedger: number,
): Pick<FetchRpcEventsOptions, "cursor" | "startLedger"> {
  if (token === null) return { startLedger: defaultStartLedger };
  return token.kind === "ledger" ? { startLedger: token.value } : { cursor: token.value };
}

function resumeTokenToBootnodeFetchOpts(
  token: ResumeToken | null,
  defaultStartLedger: number,
): Pick<FetchBootnodeEventsOptions, "cursor" | "startLedger"> {
  if (token === null) return { startLedger: defaultStartLedger };
  return token.kind === "ledger" ? { startLedger: token.value } : { cursor: token.value };
}

// ---------------------------------------------------------------------------
// Concrete sources.
// ---------------------------------------------------------------------------

export interface RpcSourceConfig {
  rpcUrl: string;
  contractIds: string[];
  startLedger: number;
  limit?: number;
  /** Network timeout in ms per `getEvents` call; default `DEFAULT_FETCH_TIMEOUT_MS`. Bounds `pollStream` so a hung RPC can't stall the worker's tick indefinitely (review fix). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real `fetchRpcEvents`. */
  fetchEvents?: typeof fetchRpcEvents;
}

/** A stream sourced purely from the Soroban RPC (the CT stream). */
export function makeRpcSource(config: RpcSourceConfig): StreamSource {
  const fetchEvents = config.fetchEvents ?? fetchRpcEvents;
  const limit = config.limit ?? DEFAULT_PAGE_LIMIT;

  return {
    async fetchPage(cursor) {
      const token = cursor === null ? null : decodeResumeToken(cursor);
      const page = await fetchEvents(config.rpcUrl, {
        contractIds: config.contractIds,
        limit,
        timeoutMs: config.timeoutMs,
        ...resumeTokenToRpcFetchOpts(token, config.startLedger),
      });
      return { events: page.events, nextCursor: encodeResumeToken(nextResumeTokenFromPage(page)) };
    },
  };
}

export interface BootnodeThenRpcSourceConfig {
  bootnodeUrl: string;
  rpcUrl: string;
  contractIds: string[];
  /** The bootnode's start ledger (e.g. `TESTNET.spp.deploymentLedger`). */
  startLedger: number;
  limit?: number;
  /** Network timeout in ms per bootnode/RPC call; default `DEFAULT_FETCH_TIMEOUT_MS` (review fix, same rationale as `RpcSourceConfig.timeoutMs`). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real `fetchBootnodeEvents`. */
  fetchBootnode?: typeof fetchBootnodeEvents;
  /** Injectable for tests; defaults to the real `fetchRpcEvents`. */
  fetchEvents?: typeof fetchRpcEvents;
}

/**
 * A stream that bootstraps from the bootnode's cached history and, once the
 * bootnode reports a retention handoff, switches permanently to the RPC
 * (the SPP stream). See the module doc for the cursor-prefix state machine
 * (`handoff:` → `rpc:`) that makes the switch restart-safe.
 */
export function makeBootnodeThenRpcSource(config: BootnodeThenRpcSourceConfig): StreamSource {
  const fetchBootnode = config.fetchBootnode ?? fetchBootnodeEvents;
  const fetchEvents = config.fetchEvents ?? fetchRpcEvents;
  const limit = config.limit ?? DEFAULT_PAGE_LIMIT;

  async function fetchViaRpc(token: ResumeToken | null): Promise<StreamFetchResult> {
    const page = await fetchEvents(config.rpcUrl, {
      contractIds: config.contractIds,
      limit,
      timeoutMs: config.timeoutMs,
      ...resumeTokenToRpcFetchOpts(token, config.startLedger),
    });
    return { events: page.events, nextCursor: RPC_PREFIX + encodeResumeToken(nextResumeTokenFromPage(page)) };
  }

  return {
    async fetchPage(cursor) {
      if (cursor !== null && cursor.startsWith(RPC_PREFIX)) {
        return fetchViaRpc(decodeResumeToken(cursor.slice(RPC_PREFIX.length)));
      }
      if (cursor !== null && cursor.startsWith(HANDOFF_PREFIX)) {
        const fromLedger = Number(cursor.slice(HANDOFF_PREFIX.length));
        return fetchViaRpc({ kind: "ledger", value: fromLedger });
      }

      // Bootnode mode: cursor is `null` (first poll) or a bare bootnode resume token.
      const token = cursor === null ? null : decodeResumeToken(cursor);
      const page = await fetchBootnode(config.bootnodeUrl, {
        contractIds: config.contractIds,
        timeoutMs: config.timeoutMs,
        ...resumeTokenToBootnodeFetchOpts(token, config.startLedger),
      });

      if ("handoff" in page) {
        return { events: [], nextCursor: `${HANDOFF_PREFIX}${page.handoff.fromLedger}` };
      }
      return { events: page.events, nextCursor: encodeResumeToken(nextResumeTokenFromPage(page)) };
    },
  };
}
