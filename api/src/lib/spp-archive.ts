/**
 * Pure decode/mapping logic for Task 8.5's SPP historical backfill (see
 * `.superpowers/sdd/2026-07-31-privacy-wallet/task-8.5-brief.md`): recovers
 * SPP contract events from stellar.expert's public archive (`api.stellar.expert`)
 * because BOTH live event sources are dead for this history — the RPC's
 * retention window starts after the SPP pool's deployment ledger, and
 * Nethermind's public bootnode rejects every filter set it's tried with
 * `-32602 unsupported filters` (see `poller.ts`'s "Live-verification blocker"
 * gotcha in `docs/modules/api.md`).
 *
 * No I/O here — `spp-archive-client.ts` owns the network calls (stellar.expert
 * pagination, Horizon txHash resolution). This module only: decomposes a
 * Stellar TOID into `{ledger, txIndex, opIndex}`, derives the transaction-level
 * TOID a TOID's operation belongs to (for the Horizon lookup), and maps one
 * archive record + its resolved `txHash` into a `RawEvent` — REUSING
 * `soroban-events.ts`'s `naturalEventId`/`eventIndexFromId` so a backfilled
 * row is byte-identical in shape to a live-RPC-sourced row (same `events.id`
 * format, same base64-XDR topic/value representation) per the brief's
 * explicit requirement.
 *
 * TOID bit layout (Stellar's total-order id: ledger(32) | txOrder(20) |
 * opOrder(12)), verified against a REAL event, not just the brief's claim:
 * live-fetched `pool` contract's first event, id `16209099200970753-0001`
 * (`ts: 1784887928` = `2026-07-24T10:12:08.000Z`), decomposes to
 * `{ledger: 3773975, txIndex: 12, opIndex: 1}` — 3773975 falls inside
 * `[3773948 (SPP pool deploymentLedger), 3780963 (RPC retention start)]` per
 * the brief's known-vector check (`decomposeToid.test.ts`... see
 * `spp-archive.test.ts`). The resolved Horizon transaction hash for that
 * exact event (`78ec67bab912b3e653fdad92b7f9784e9df7c41fb3407094095dd97b0ab2a34f`,
 * ledger 3773975, `created_at: 2026-07-24T10:12:08Z`) matches the event's own
 * `ts` exactly, cross-confirming both the bit-layout AND that Horizon
 * testnet's history reaches back this far (post-reset, per the brief).
 *
 * Horizon txHash resolution note (refines the brief's literal recipe): the
 * brief says `cursor=<toid-1>`. Verified live that this is only correct when
 * the event's `opIndex` is 0 — Horizon's `/transactions` collection only has
 * paging tokens at `opOrder=0` (one entry per tx, not per operation), so for
 * an event with `opIndex > 0` (the common case — most ops emit several
 * events), `cursor = eventToid - 1` overshoots into the NEXT transaction.
 * The correct cursor is `txToid(eventToid) - 1`, where `txToid` zeroes the
 * low 12 (opOrder) bits first — `txToidForEvent` below. Verified against the
 * event above (`opIndex: 1`): `cursor=<eventToid-1>` returned the WRONG tx
 * (paging_token one tx later); `cursor=<txToid-1>` returned the correct one.
 * `spp-archive-client.ts`'s `resolveTxHash` additionally asserts the returned
 * transaction's own `paging_token` equals the expected `txToid` (the brief's
 * "the tx whose paging_token's TOID prefix matches" check) rather than
 * trusting Horizon's cursor semantics blindly.
 */
import { eventIndexFromId, naturalEventId, type RawEvent } from "./soroban-events.js";

/** One event record as stellar.expert's `GET .../contract/<id>/events` returns it (verified live 2026-08-01 against the shape the brief documents — extra fields `topics`/`initiator`/`paging_token` exist on the wire but are unused here). */
export interface ArchiveEventRecord {
  /** `<toid>-<eventIndex>`, e.g. `"16209099200970753-0001"`. */
  id: string;
  /** Unix seconds — ledger close time. */
  ts: number;
  contract: string;
  /** Base64 ScVal XDR, one per topic — used as-is (matches `RawEvent.topic`'s wire form for both live sources). */
  topicsXdr: string[];
  /** Base64 ScVal XDR — the event's value/body. */
  bodyXdr: string;
}

export interface ToidParts {
  ledger: number;
  txIndex: number;
  opIndex: number;
}

const OP_ORDER_BITS = 12n;
const TX_ORDER_BITS = 20n;
const OP_ORDER_MASK = 0xfffn; // 12 bits
const TX_ORDER_MASK = 0xfffffn; // 20 bits

/** Decompose a Stellar TOID: `ledger(32) | txOrder(20) | opOrder(12)`. */
export function decomposeToid(toid: bigint): ToidParts {
  return {
    ledger: Number(toid >> (OP_ORDER_BITS + TX_ORDER_BITS)),
    txIndex: Number((toid >> OP_ORDER_BITS) & TX_ORDER_MASK),
    opIndex: Number(toid & OP_ORDER_MASK),
  };
}

/** The transaction-level TOID (opOrder zeroed) an event's TOID belongs to — see module doc's Horizon resolution note. */
export function txToidForEvent(eventToid: bigint): bigint {
  return eventToid & ~OP_ORDER_MASK;
}

/** Extract the numeric TOID prefix from an archive record's `id`/`<toid>-<eventIndex>` — the counterpart to `soroban-events.ts`'s `eventIndexFromId`, which extracts the suffix. */
export function toidFromArchiveId(id: string): bigint {
  const idx = id.lastIndexOf("-");
  if (idx === -1) {
    throw new Error(`toidFromArchiveId: cannot parse toid from archive event id "${id}"`);
  }
  const toidPart = id.slice(0, idx);
  if (!/^\d+$/.test(toidPart)) {
    throw new Error(`toidFromArchiveId: archive event id "${id}" has a non-numeric toid segment "${toidPart}"`);
  }
  return BigInt(toidPart);
}

/**
 * Map one stellar.expert archive record + its resolved Horizon `txHash` into
 * a `RawEvent` — the same shape `fetchRpcEvents`/`fetchBootnodeEvents`
 * produce, per the task-8.5 brief's requirement that backfilled and live
 * rows be indistinguishable. `inSuccessfulCall` is hardcoded `true`:
 * stellar.expert's archive only ever records events actually emitted
 * on-chain (a failed call emits no events to archive).
 */
export function mapArchiveRecordToRawEvent(record: ArchiveEventRecord, txHash: string): RawEvent {
  const toid = toidFromArchiveId(record.id);
  const { ledger, txIndex, opIndex } = decomposeToid(toid);
  const eventIndex = eventIndexFromId(record.id);
  return {
    id: naturalEventId({ ledger, txHash, opIndex, eventIndex }),
    contractId: record.contract,
    ledger,
    ledgerClosedAt: new Date(record.ts * 1000),
    txHash,
    txIndex,
    opIndex,
    eventIndex,
    topic: record.topicsXdr,
    valueXdr: record.bodyXdr,
    inSuccessfulCall: true,
  };
}

/** Deterministic ordering for the committed fixture — by TOID, then event index (the brief's "sorted by TOID+eventIndex"), contractId as a final tiebreak for full determinism across contracts sharing a ledger. */
export function compareArchiveOrder(a: RawEvent, b: RawEvent): number {
  const toidA = (BigInt(a.ledger) << 32n) | (BigInt(a.txIndex) << 12n) | BigInt(a.opIndex);
  const toidB = (BigInt(b.ledger) << 32n) | (BigInt(b.txIndex) << 12n) | BigInt(b.opIndex);
  if (toidA !== toidB) return toidA < toidB ? -1 : 1;
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  return a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0;
}
