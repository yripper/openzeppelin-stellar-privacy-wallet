/**
 * Soroban RPC `getEvents` adapter — one of the two `EventsPage` sources the
 * indexer worker (Task 7) drives (the other is `bootnode-client.ts`). Both
 * return the identical `EventsPage` shape so the poller can switch sources
 * (bootnode until the retention handoff, then this RPC source) without
 * branching on where an event came from.
 *
 * Ported from troqpay's `api/src/lib/soroban-gateway.ts:185` `getContractEvents`
 * (written against `@stellar/stellar-sdk@14.6.1`), adapted to this repo's
 * pinned `@stellar/stellar-sdk@16.2.0`. This module is a pure I/O adapter: no
 * DB access, no retry/backoff (Task 7 owns retry policy), no logging beyond
 * returning data.
 *
 * sdk-16 response-shape findings, verified against the INSTALLED package
 * (`node_modules/.pnpm/@stellar+stellar-sdk@16.2.0/.../lib/esm/rpc/api.d.ts`),
 * not trusted from the troqpay note or the task brief blindly:
 * - `Api.EventResponse.contractId` is `Contract | undefined` (api.d.ts:257-258)
 *   — a class instance, not a string; the strkey comes from `.contractId()`.
 *   Same finding as troqpay's sdk-14 note (unchanged across the bump).
 * - The topics field is `topic` (singular), `xdr.ScVal[]` (api.d.ts:259).
 *   Same finding as troqpay's sdk-14 note (unchanged).
 * - UNLIKE sdk-14 (troqpay's `SorobanContractEvent` only had
 *   id/ledger/contractId/txHash/topic/value), sdk-16's `BaseEventResponse`
 *   (api.d.ts:266-275) now ALSO carries `ledgerClosedAt: string`,
 *   `transactionIndex: number`, `operationIndex: number`, and
 *   `inSuccessfulContractCall: boolean` directly on every event. This means
 *   `opIndex`/`txIndex` no longer need the toid bit-masking trick
 *   `@ctd/sdk` uses for an older SDK (`packages/ctd-sdk/src/chain/events.ts:249`
 *   `rpcEventCoords`) — `event.operationIndex`/`event.transactionIndex` are
 *   used directly here.
 * - `eventIndex` still has no dedicated field on `BaseEventResponse`. It is
 *   recovered from the second segment of `id` (`<toid>-<eventOrder>`, e.g.
 *   `0004100553739857920-0000000003`), the same technique `@ctd/sdk`'s
 *   `rpcEventCoords` uses for the same purpose. The `id`-format claim itself
 *   is NOT asserted by the installed `.d.ts` (typed only as `string`) — the
 *   SDK's only documentation of it is a stale doc comment on
 *   `RpcServer.getEvents` (`lib/esm/rpc/server.js:826`) that calls the field
 *   `pagingToken` (a name that does not exist on `EventResponse`; the actual
 *   field is `id`). Treated here as a wire-format assumption, consistent
 *   with the task brief's own example id.
 * - `ledgerClosedAt`'s exact string format (RFC3339/ISO8601) is likewise not
 *   pinned by the installed `.d.ts` (typed only as `string`); `new Date(...)`
 *   assumes the public Stellar RPC API reference's documented ISO8601
 *   convention, which is not independently verified in this repo.
 *
 * `events.id` MUST be `${ledger}-${txHash}-${opIndex}-${eventIndex}` — the
 * same format as `@ctd/sdk`'s `naturalEventId`
 * (`packages/ctd-sdk/src/chain/events.ts:236`), per the Task-5 schema's
 * doc comment (`api/src/db/schema.ts:22-25`, "Do not invent a different id
 * format here"). `naturalEventId` below REPLICATES that format rather than
 * importing `@ctd/sdk` — that package pulls in the zk-proving stack
 * (`@aztec/bb.js`, `@noir-lang/noir_js`), which `@grantfox/api` has no other
 * reason to depend on for one string-template function.
 */
import { rpc, type xdr } from "@stellar/stellar-sdk";

/** One on-chain event, shaped to insert directly into the Task-5 `events` table. */
export interface RawEvent {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  txIndex: number;
  opIndex: number;
  eventIndex: number;
  /** Each topic's XDR, base64-encoded — same wire form for both event sources (see bootnode-client.ts). */
  topic: string[];
  valueXdr: string;
  inSuccessfulCall: boolean;
}

/** One page of events, common to both the RPC and bootnode sources. */
export interface EventsPage {
  events: RawEvent[];
  latestLedger: number;
  /** Resume token for the next page; `null` when the source reports no further cursor. */
  cursor: string | null;
  oldestLedger: number;
}

export interface FetchRpcEventsOptions {
  contractIds: string[];
  startLedger?: number;
  cursor?: string;
  limit: number;
}

/**
 * The per-operation event ordinal, recovered from the second segment of an
 * RPC-style event `id` (`<toid>-<eventOrder>`) — see module doc. Exported so
 * `bootnode-client.ts` can reuse it (bootnode `id`s are the same RPC-sourced
 * format).
 */
export function eventIndexFromId(id: string): number {
  const parts = id.split("-");
  const eventOrder = parts[parts.length - 1];
  const n = eventOrder === undefined ? Number.NaN : Number(eventOrder);
  if (!Number.isInteger(n)) {
    throw new Error(`cannot parse event index from event id "${id}"`);
  }
  return n;
}

/**
 * `${ledger}-${txHash}-${opIndex}-${eventIndex}` — replicates `@ctd/sdk`'s
 * `naturalEventId` (`packages/ctd-sdk/src/chain/events.ts:236`) so `events.id`
 * dedupes identically whether a row came from the RPC or the bootnode.
 */
export function naturalEventId(p: {
  ledger: number;
  txHash: string;
  opIndex: number;
  eventIndex: number;
}): string {
  return `${p.ledger}-${p.txHash}-${p.opIndex}-${p.eventIndex}`;
}

function mapEvent(event: rpc.Api.EventResponse): RawEvent {
  const contractId = event.contractId?.contractId();
  if (contractId === undefined) {
    throw new Error(`fetchRpcEvents: event ${event.id} has no contractId`);
  }
  const eventIndex = eventIndexFromId(event.id);
  return {
    id: naturalEventId({
      ledger: event.ledger,
      txHash: event.txHash,
      opIndex: event.operationIndex,
      eventIndex,
    }),
    contractId,
    ledger: event.ledger,
    ledgerClosedAt: new Date(event.ledgerClosedAt),
    txHash: event.txHash,
    txIndex: event.transactionIndex,
    opIndex: event.operationIndex,
    eventIndex,
    topic: event.topic.map((t: xdr.ScVal) => t.toXDR("base64")),
    valueXdr: event.value.toXDR("base64"),
    inSuccessfulCall: event.inSuccessfulContractCall,
  };
}

/** Fetch one page of contract events from a Soroban RPC endpoint, wrapping `rpc.Server.getEvents`. */
export async function fetchRpcEvents(rpcUrl: string, opts: FetchRpcEventsOptions): Promise<EventsPage> {
  const { contractIds, startLedger, cursor, limit } = opts;
  const server = new rpc.Server(rpcUrl);
  const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds }];

  let response: rpc.Api.GetEventsResponse;
  if (cursor !== undefined) {
    response = await server.getEvents({ filters, cursor, limit });
  } else if (startLedger !== undefined) {
    response = await server.getEvents({ filters, startLedger, limit });
  } else {
    throw new Error("fetchRpcEvents requires a startLedger or a cursor");
  }

  return {
    events: response.events.map(mapEvent),
    latestLedger: response.latestLedger,
    cursor: response.cursor || null,
    oldestLedger: response.oldestLedger,
  };
}
