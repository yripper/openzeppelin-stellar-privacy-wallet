/**
 * Bootnode-protocol JSON-RPC handler: `getEvents`/`getLatestLedger` business
 * logic, transport-agnostic (returns a typed `RpcOutcome`, never throws for
 * an EXPECTED JSON-RPC error case — only for a genuinely unexpected
 * failure, e.g. the DB or upstream RPC being unreachable, which the
 * transport layer, `routes.ts`, catches and maps to a generic `-32603`).
 *
 * Protocol reference (read, not guessed): `resources/stellar-private-payments/tools/bootnode/src/rpc.rs`
 * (validation order, error codes `-32002`/`-32004`/`-32602`) and
 * `.../tools/bootnode/src/messages.rs` (`GetEventsParams`/`ContractEventFilter`/
 * `PaginationParams`, all `#[serde(deny_unknown_fields)]`; `Event`/`GetEventsResponse`
 * field names — IDENTICAL to the SDK client's own deserializer struct,
 * `resources/stellar-private-payments/sdk/stellar/src/rpc.rs:111-165`).
 *
 * **Our bootnode's handoff/cache-miss semantics deliberately diverge from
 * the reference implementation's** (documented in the task-9 brief): the
 * reference bootnode is a partial, asynchronously-populated CACHE in front
 * of the real RPC, tracking `ledger_tip`/`in_sync` state and a background
 * indexer that may or may not have gotten to a given page yet — hence its
 * multi-branch `cache_miss_or_handoff` logic (tip unknown vs. in-sync vs.
 * catching-up). OUR bootnode serves directly and synchronously from a
 * FULLY MATERIALIZED `events` table (full archival history from Task 8.5's
 * backfill + continuous live-follow via the worker, Task 7/9) — there is no
 * "known but not yet cached" state to distinguish. This collapses to two
 * simple, always-consistent rules:
 * - **cache miss (`-32004`)**: the request's `pagination.cursor` doesn't
 *   resolve to any row we have for the allowed contract set (unresolvable —
 *   stale, malformed, or minted by a different deployment). This is the
 *   ONLY source of `-32004` here; there is no "warming up" distinction to
 *   make once the backfill has run once.
 * - **handoff (`-32002`)**: the resolved query (by `startLedger` or by
 *   `cursor`) returns ZERO rows. Given `ourTip = MAX(ledger)` among the
 *   allowed contracts' rows, this is mathematically equivalent to "the
 *   request's effective starting ledger is beyond `ourTip`" for the
 *   `startLedger` case (any ledger `<= ourTip` is guaranteed to have at
 *   least the row(s) AT `ourTip` in range), and for the `cursor` case means
 *   "nothing has been indexed past what this cursor already pointed to" —
 *   in both cases the client's own RPC is the only place newer data could
 *   possibly be. `fromLedger = ourTip + 1`, matching the reference's own
 *   `retention_handoff(from_ledger)` payload shape exactly
 *   (`{reason:"retention_threshold", fromLedger}`, `rpc.rs:273-282`).
 *
 * Validation order (rpc.rs `get_events` + `get_events_handler`, replicated
 * exactly since the brief calls this out as significant): params shape
 * (zod, `deny_unknown_fields`-equivalent via `.strict()`) -> `endLedger` ->
 * `xdrFormat` -> exactly one of `startLedger`/`pagination.cursor` ->
 * `is_allowed_filters`.
 */
import { z } from "zod";
import type { RepoOps } from "../../db/repo.js";
import type { EventRow } from "../../db/schema.js";
import type { UpstreamLatestLedger } from "../../lib/rpc-proxy.js";
import { fetchUpstreamLatestLedger } from "../../lib/rpc-proxy.js";

/** `-32002`: tell the client to resume on its own RPC (`tools/bootnode/src/rpc.rs:28`). */
export const RETENTION_HANDOFF_CODE = -32_002;
/** `-32602`: standard JSON-RPC invalid params (`tools/bootnode/src/rpc.rs:253-255`). */
export const INVALID_PARAMS_CODE = -32_602;
/** `-32004`: bootnode-specific cache-miss (`tools/bootnode/src/rpc.rs:21`). */
export const CACHE_MISS_CODE = -32_004;
/** `-32603`: standard JSON-RPC internal error (`tools/bootnode/src/rpc.rs:257-259`). */
export const INTERNAL_ERROR_CODE = -32_603;

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcOutcome<T> = { ok: true; result: T } | { ok: false; error: JsonRpcError };

function ok<T>(result: T): RpcOutcome<T> {
  return { ok: true, result };
}

function err<T>(code: number, message: string, data?: unknown): RpcOutcome<T> {
  return data === undefined ? { ok: false, error: { code, message } } : { ok: false, error: { code, message, data } };
}

/** The narrow slice of `RepoOps` the bootnode handler needs. */
export type BootnodeRepoDeps = Pick<RepoOps, "listEventsFromLedger" | "listEventsAfterId" | "getLedgerBounds">;

export interface BootnodeHandlerDeps {
  repo: BootnodeRepoDeps;
  /** The SPP contract set this bootnode serves — MUST be set-equal to the SDK's `all_contract_ids()` request (see `worker.ts`'s `buildSppContractIds`). */
  allowedContractIds: string[];
  /** Upstream Soroban RPC URL, proxied live for `getLatestLedger` and `getEvents`'s `latestLedger`/`latestLedgerCloseTime`. */
  rpcUrl: string;
  /** Injectable for tests; defaults to the real `fetchUpstreamLatestLedger`. */
  fetchLatestLedger?: (rpcUrl: string) => Promise<UpstreamLatestLedger>;
}

// ---------------------------------------------------------------------------
// Wire types (messages.rs / sdk/stellar/src/rpc.rs's Event & GetEventsResponse — byte-for-byte field names).
// ---------------------------------------------------------------------------

export interface WireEvent {
  type: "contract";
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  operationIndex: number;
  transactionIndex: number;
  txHash: string;
  inSuccessfulContractCall: boolean;
  topic: string[];
  value: string;
}

export interface GetEventsResult {
  events: WireEvent[];
  latestLedger: number;
  latestLedgerCloseTime: string;
  oldestLedger: number;
  oldestLedgerCloseTime: string;
  cursor: string;
}

export interface GetLatestLedgerResult {
  id: string;
  protocolVersion: number;
  sequence: number;
}

function mapEventRow(row: EventRow): WireEvent {
  return {
    type: "contract",
    ledger: row.ledger,
    ledgerClosedAt: row.ledgerClosedAt.toISOString(),
    contractId: row.contractId,
    id: row.id,
    operationIndex: row.opIndex,
    transactionIndex: row.txIndex,
    txHash: row.txHash,
    inSuccessfulContractCall: row.inSuccessfulCall,
    topic: row.topic as string[],
    value: row.valueXdr,
  };
}

// ---------------------------------------------------------------------------
// Params validation (messages.rs's GetEventsParams/ContractEventFilter/PaginationParams).
// ---------------------------------------------------------------------------

const contractEventFilterSchema = z
  .object({
    type: z.string(),
    topics: z.array(z.array(z.string())),
    contractIds: z.array(z.string()),
  })
  .strict();

const paginationSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    cursor: z.string().optional(),
  })
  .strict();

const getEventsParamsSchema = z
  .object({
    filters: z.array(contractEventFilterSchema).default([]),
    pagination: paginationSchema.default({}),
    startLedger: z.number().int().nonnegative().optional(),
    endLedger: z.number().int().nonnegative().optional(),
    xdrFormat: z.string().optional(),
  })
  .strict();

type ContractEventFilter = z.infer<typeof contractEventFilterSchema>;

/** `GetEventsParams::is_allowed_filters` (messages.rs:134-152) — exactly one filter, type "contract", topics `[["**"]]`, contractIds set-equal (order-independent) to `allowed`. */
function isAllowedFilters(filters: ContractEventFilter[], allowed: string[]): boolean {
  if (filters.length !== 1) return false;
  const first = filters[0]!;
  if (first.type !== "contract") return false;
  if (first.topics.length !== 1 || first.topics[0]!.length !== 1 || first.topics[0]![0] !== "**") return false;

  const got = [...first.contractIds].sort();
  const want = [...allowed].sort();
  if (got.length !== want.length) return false;
  return got.every((id, i) => id === want[i]);
}

function clampLimit(limit: number | undefined): number {
  const requested = limit ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(requested, MAX_LIMIT));
}

/**
 * `getEvents`. See module doc for the handoff/cache-miss decision table.
 * Never throws for an expected JSON-RPC error case; a thrown error here
 * means the DB or (on the serve path) the upstream RPC call failed —
 * `routes.ts` maps that to a generic `-32603`.
 */
export async function handleGetEvents(rawParams: unknown, deps: BootnodeHandlerDeps): Promise<RpcOutcome<GetEventsResult>> {
  const parsed = getEventsParamsSchema.safeParse(rawParams ?? {});
  if (!parsed.success) {
    return err(INVALID_PARAMS_CODE, `invalid getEvents params: ${parsed.error.message}`);
  }
  const params = parsed.data;

  if (params.endLedger !== undefined) {
    return err(INVALID_PARAMS_CODE, "endLedger is not supported by bootnode");
  }
  if (params.xdrFormat !== undefined) {
    return err(INVALID_PARAMS_CODE, "xdrFormat is not supported by bootnode");
  }

  const hasStart = params.startLedger !== undefined;
  const hasCursor = params.pagination.cursor !== undefined;
  if (hasStart === hasCursor) {
    return err(
      INVALID_PARAMS_CODE,
      hasStart
        ? "getEvents params must include either startLedger or pagination.cursor, not both"
        : "getEvents params must include either startLedger or pagination.cursor",
    );
  }

  if (!isAllowedFilters(params.filters, deps.allowedContractIds)) {
    return err(INVALID_PARAMS_CODE, "unsupported filters");
  }

  const limit = clampLimit(params.pagination.limit);
  const fetchLatestLedger = deps.fetchLatestLedger ?? fetchUpstreamLatestLedger;

  let rows: EventRow[];
  if (hasCursor) {
    const page = await deps.repo.listEventsAfterId({
      contractIds: deps.allowedContractIds,
      afterId: params.pagination.cursor!,
      limit,
    });
    if (page === null) {
      return err(CACHE_MISS_CODE, "cache miss; cursor not found");
    }
    rows = page;
  } else {
    rows = await deps.repo.listEventsFromLedger({
      contractIds: deps.allowedContractIds,
      fromLedger: params.startLedger!,
      limit,
    });
  }

  const bounds = await deps.repo.getLedgerBounds(deps.allowedContractIds);
  const ourTip = bounds?.max ?? -1;

  if (rows.length === 0) {
    return err(RETENTION_HANDOFF_CODE, "Continue syncing on your RPC endpoint", {
      reason: "retention_threshold",
      fromLedger: ourTip + 1,
    });
  }

  const upstream = await fetchLatestLedger(deps.rpcUrl);
  const firstRow = rows[0]!;
  const lastRow = rows[rows.length - 1]!;

  return ok({
    events: rows.map(mapEventRow),
    latestLedger: upstream.sequence,
    latestLedgerCloseTime: upstream.closeTime,
    // `oldestLedger` is our archive floor (real, from `bounds`); `oldestLedgerCloseTime`
    // is the oldest row IN THIS PAGE (a real timestamp, not a placeholder) rather than a
    // 3rd DB round-trip to fetch the floor row's own timestamp — deliberate, since neither
    // field is consumed by the SDK's own sync logic (only `latestLedger`/`cursor` are, see
    // module doc / task-9 report's deserializer-parity citations).
    oldestLedger: bounds?.min ?? 0,
    oldestLedgerCloseTime: firstRow.ledgerClosedAt.toISOString(),
    cursor: lastRow.id,
  });
}

/** `getLatestLedger` — a live proxy, nothing else (brief: "proxy upstream RPC live"). */
export async function handleGetLatestLedger(deps: BootnodeHandlerDeps): Promise<RpcOutcome<GetLatestLedgerResult>> {
  const fetchLatestLedger = deps.fetchLatestLedger ?? fetchUpstreamLatestLedger;
  const upstream = await fetchLatestLedger(deps.rpcUrl);
  return ok({ id: upstream.id, protocolVersion: upstream.protocolVersion, sequence: upstream.sequence });
}
