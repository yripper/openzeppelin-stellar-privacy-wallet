/**
 * Bootnode `getEvents` adapter — the other `EventsPage` source the indexer
 * worker (Task 7) drives (see `soroban-events.ts` for the RPC source). The
 * bootnode caches `getEvents` pages from a CT contract's deployment ledger
 * onward so a client can bootstrap history past the RPC's retention window;
 * once the request range is within the retention buffer, it hands off back
 * to the RPC via a JSON-RPC error rather than serving a page. Pure I/O
 * adapter: no DB access, no retry/backoff (Task 7 owns retry policy), no
 * logging beyond returning data. Mocks `fetch` in tests — never hits a live
 * bootnode.
 *
 * Protocol source (read, not blindly trusted from the task brief's
 * flattened params sketch): `resources/stellar-private-payments/tools/bootnode/src/rpc.rs:17-28`
 * (error codes) and `.../tools/bootnode/src/messages.rs` (request/response
 * structs) and `resources/stellar-private-payments/docs/src/bootnode.md`.
 *
 * Wire-shape correction vs. the task brief: the brief's params sketch is
 * `{filters, startLedger?|cursor?, limit?}` (flat). The actual
 * `#[rpc(... param_kind = map)]` trait method
 * (`tools/bootnode/src/rpc.rs:35-43`) takes named params
 * `(filters, pagination, start_ledger, end_ledger, xdr_format)`, and
 * `GetEventsParams` (`tools/bootnode/src/messages.rs:6-19`) nests `limit`
 * and `cursor` under a `pagination: {limit?, cursor?}` object, NOT at the
 * top level. `GetEventsParams` is `#[serde(deny_unknown_fields)]`, so a
 * flat `{filters, cursor, limit}` body would fail server-side deserialization
 * (JSON-RPC `-32602`/parse error) — this adapter sends `pagination.cursor`,
 * matching the actual struct.
 *
 * Event field shape (`tools/bootnode/src/messages.rs:70-106`): the bootnode's
 * `Event` struct mirrors the raw (pre-XDR-parse) Stellar RPC `getEvents`
 * wire shape — `topic: Vec<String>` and `value: String` are base64-encoded
 * XDR, not decoded ScVal — so they are passed through here unchanged. This
 * keeps `RawEvent.topic`/`valueXdr` in the SAME base64-XDR-string
 * representation `soroban-events.ts` produces (it re-encodes the SDK's
 * already-parsed `xdr.ScVal`s back to base64 via `.toXDR("base64")`), so a
 * `RawEvent` row is bitwise-identical in shape regardless of which source
 * produced it.
 *
 * `operationIndex`/`transactionIndex`/`txHash`/`inSuccessfulContractCall`
 * are typed `Option` on the Rust `Event` struct (messages.rs:83-102, for
 * forward/backward cache-format compatibility), but the `events` table
 * requires them NOT NULL and `events.id` cannot be constructed without
 * `txHash`/`operationIndex`. This adapter fails fast (throws) if a mapped
 * event is missing any of them, rather than guessing or silently dropping
 * the row — see the task report for why this is judged acceptable for a
 * hackathon-scope adapter (Task 7 owns deciding what to do with a thrown
 * mapping error, e.g. surfacing/alerting).
 */
import { eventIndexFromId, naturalEventId, type EventsPage, type RawEvent } from "./soroban-events.js";

export interface FetchBootnodeEventsOptions {
  contractIds: string[];
  startLedger?: number;
  cursor?: string;
}

/** `-32004`: bootnode has no cached page yet (cold tip, or indexer hasn't caught up). Retry with backoff — Task 7's call. */
export class BootnodeCacheMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootnodeCacheMissError";
  }
}

/** `resources/stellar-private-payments/tools/bootnode/src/rpc.rs:28` */
const RETENTION_HANDOFF_CODE = -32002;
/** `resources/stellar-private-payments/tools/bootnode/src/rpc.rs:21` */
const CACHE_MISS_CODE = -32004;

/** The bootnode's raw (pre-XDR-parse) event wire shape — `tools/bootnode/src/messages.rs:70-106`. */
interface BootnodeWireEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  operationIndex?: number;
  transactionIndex?: number;
  txHash?: string;
  inSuccessfulContractCall?: boolean;
  topic: string[];
  value: string;
}

interface BootnodeGetEventsResult {
  events: BootnodeWireEvent[] | null;
  latestLedger: number;
  latestLedgerCloseTime: string;
  oldestLedger: number;
  oldestLedgerCloseTime: string;
  cursor: string;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: { reason?: string; fromLedger?: number };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: BootnodeGetEventsResult;
  error?: JsonRpcErrorPayload;
}

function mapBootnodeEvent(event: BootnodeWireEvent): RawEvent {
  const { operationIndex, transactionIndex, txHash, inSuccessfulContractCall } = event;
  if (
    operationIndex === undefined ||
    transactionIndex === undefined ||
    txHash === undefined ||
    inSuccessfulContractCall === undefined
  ) {
    throw new Error(
      `fetchBootnodeEvents: event ${event.id} is missing a required field (operationIndex/transactionIndex/txHash/inSuccessfulContractCall)`,
    );
  }
  const eventIndex = eventIndexFromId(event.id);
  return {
    id: naturalEventId({ ledger: event.ledger, txHash, opIndex: operationIndex, eventIndex }),
    contractId: event.contractId,
    ledger: event.ledger,
    ledgerClosedAt: new Date(event.ledgerClosedAt),
    txHash,
    txIndex: transactionIndex,
    opIndex: operationIndex,
    eventIndex,
    topic: event.topic,
    valueXdr: event.value,
    inSuccessfulCall: inSuccessfulContractCall,
  };
}

/**
 * Fetch one page of contract events from a bootnode over JSON-RPC 2.0.
 * Resolves to a `{handoff: {fromLedger}}` marker on `-32002` (retention
 * handoff — Task 7 should switch to `fetchRpcEvents` from `fromLedger`).
 * Throws `BootnodeCacheMissError` on `-32004` (retry-later); throws a plain
 * `Error` for any other JSON-RPC error or malformed response.
 */
export async function fetchBootnodeEvents(
  url: string,
  opts: FetchBootnodeEventsOptions,
): Promise<EventsPage | { handoff: { fromLedger: number } }> {
  const { contractIds, startLedger, cursor } = opts;
  if (cursor === undefined && startLedger === undefined) {
    throw new Error("fetchBootnodeEvents requires a startLedger or a cursor");
  }

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getEvents",
    params: {
      filters: [{ type: "contract", topics: [["**"]], contractIds }],
      pagination: cursor !== undefined ? { cursor } : {},
      ...(startLedger !== undefined ? { startLedger } : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as JsonRpcResponse;

  if (json.error) {
    const { code, message, data } = json.error;
    if (code === RETENTION_HANDOFF_CODE) {
      if (data?.fromLedger === undefined) {
        throw new Error(
          `fetchBootnodeEvents: retention handoff error missing data.fromLedger: ${JSON.stringify(json.error)}`,
        );
      }
      return { handoff: { fromLedger: data.fromLedger } };
    }
    if (code === CACHE_MISS_CODE) {
      throw new BootnodeCacheMissError(message);
    }
    throw new Error(`fetchBootnodeEvents: JSON-RPC error ${code}: ${message}`);
  }

  if (!json.result) {
    throw new Error("fetchBootnodeEvents: response has neither result nor error");
  }

  return {
    events: (json.result.events ?? []).map(mapBootnodeEvent),
    latestLedger: json.result.latestLedger,
    cursor: json.result.cursor || null,
    oldestLedger: json.result.oldestLedger,
  };
}
