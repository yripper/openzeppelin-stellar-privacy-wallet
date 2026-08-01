/**
 * TDD spec for Task 8.5's pure SPP-archive logic (`spp-archive.ts`): TOID
 * decomposition (known-vector, per the brief) and archive-record→`RawEvent`
 * mapping. All fixtures below are REAL data, live-fetched 2026-08-01 from
 * `https://api.stellar.expert/explorer/testnet/contract/CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI/events?order=asc&limit=3`
 * and cross-resolved via `https://horizon-testnet.stellar.org/transactions`
 * (see `spp-archive.ts`'s module doc for the resolution transcript) — not
 * hand-constructed, so these tests double as the "known-vector" proof the
 * brief requires before trusting the bit-layout decomposition.
 */
import { describe, expect, it } from "vitest";
import {
  compareArchiveOrder,
  decomposeToid,
  mapArchiveRecordToRawEvent,
  toidFromArchiveId,
  txToidForEvent,
  type ArchiveEventRecord,
} from "./spp-archive.js";

describe("decomposeToid — known vector (task-8.5 brief)", () => {
  it("decomposes the pool contract's first live event TOID into ledger/txIndex/opIndex", () => {
    // id: "16209099200970753-0001", the pool contract's first-ever event.
    const toid = 16209099200970753n;

    const parts = decomposeToid(toid);

    // Real values (not just the range check) — Horizon independently
    // confirms ledger 3773975 for this exact event (see module doc).
    expect(parts).toEqual({ ledger: 3773975, txIndex: 12, opIndex: 1 });
    // The brief's literal known-vector assertion: SPP pool deploymentLedger
    // (3773948) <= ledger <= RPC retention start (3780963).
    expect(parts.ledger).toBeGreaterThanOrEqual(3773948);
    expect(parts.ledger).toBeLessThanOrEqual(3780963);
  });

  it("round-trips: recomposing ledger/txIndex/opIndex reproduces the original TOID", () => {
    const toid = 16209099200970753n;
    const { ledger, txIndex, opIndex } = decomposeToid(toid);

    const recomposed = (BigInt(ledger) << 32n) | (BigInt(txIndex) << 12n) | BigInt(opIndex);

    expect(recomposed).toBe(toid);
  });

  it("decomposes a second real event (a different ledger/tx entirely) from the public_key_registry contract", () => {
    // id: "16734107413278721-0000", live-fetched from
    // CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36.
    const toid = 16734107413278721n;

    expect(decomposeToid(toid)).toEqual({ ledger: 3896213, txIndex: 7, opIndex: 1 });
  });
});

describe("txToidForEvent — the Horizon-resolution refinement (see module doc)", () => {
  it("zeroes the low 12 (opOrder) bits, matching the real transaction-level TOID Horizon returned", () => {
    // Live-verified: Horizon's actual tx paging_token for this event's
    // operation is 16209099200970752 (opIndex 0), NOT `eventToid - 1`'s
    // naive target — see module doc for the full transcript.
    const eventToid = 16209099200970753n;

    expect(txToidForEvent(eventToid)).toBe(16209099200970752n);
  });

  it("is a no-op for a TOID that is already at opIndex 0 (the tx-level TOID itself, live-verified as the resolved transaction's own paging_token)", () => {
    const txLevelToid = 16209099200970752n;
    expect(txToidForEvent(txLevelToid)).toBe(txLevelToid);
  });
});

describe("toidFromArchiveId", () => {
  it("extracts the numeric TOID prefix from a real archive id", () => {
    expect(toidFromArchiveId("16209099200970753-0001")).toBe(16209099200970753n);
  });

  it("throws on an id with no separator", () => {
    expect(() => toidFromArchiveId("notanid")).toThrow(/cannot parse toid/);
  });

  it("throws on a non-numeric toid segment", () => {
    expect(() => toidFromArchiveId("abc-0001")).toThrow(/non-numeric toid segment/);
  });
});

describe("mapArchiveRecordToRawEvent — real record mapping", () => {
  // The pool contract's first-ever live event, verbatim from stellar.expert
  // (fetched 2026-08-01) — same event as the known-vector case above.
  const realRecord: ArchiveEventRecord = {
    id: "16209099200970753-0001",
    ts: 1784887928,
    contract: "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
    topicsXdr: ["AAAADwAAABNuZXdfbnVsbGlmaWVyX2V2ZW50AA==", "AAAACwDo7IYLyqpmoBFHC53ZnBwFA+pAlu6Zu8gDu6GAuvVA"],
    bodyXdr: "AAAAEQAAAAEAAAAA",
  };
  // Resolved live via Horizon for this exact TOID (see module doc's transcript).
  const realTxHash = "78ec67bab912b3e653fdad92b7f9784e9df7c41fb3407094095dd97b0ab2a34f";

  it("maps a real record to the exact RawEvent shape, matching soroban-events.ts's row format", () => {
    const raw = mapArchiveRecordToRawEvent(realRecord, realTxHash);

    expect(raw).toEqual({
      id: `3773975-${realTxHash}-1-1`,
      contractId: "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
      ledger: 3773975,
      ledgerClosedAt: new Date("2026-07-24T10:12:08.000Z"),
      txHash: realTxHash,
      txIndex: 12,
      opIndex: 1,
      eventIndex: 1,
      topic: realRecord.topicsXdr,
      valueXdr: realRecord.bodyXdr,
      inSuccessfulCall: true,
    });
  });

  it("ledgerClosedAt derives from ts exactly as the brief specifies (new Date(ts*1000).toISOString())", () => {
    const raw = mapArchiveRecordToRawEvent(realRecord, realTxHash);
    expect(raw.ledgerClosedAt.toISOString()).toBe(new Date(realRecord.ts * 1000).toISOString());
    // Cross-check against Horizon's own created_at for the resolved tx
    // (independently confirms the ts field IS ledger close time).
    expect(raw.ledgerClosedAt.toISOString()).toBe("2026-07-24T10:12:08.000Z");
  });

  it("two events sharing a TOID (same tx, different eventIndex) produce distinct ids that both embed the same txHash/ledger", () => {
    const secondRecord: ArchiveEventRecord = {
      ...realRecord,
      id: "16209099200970753-0002",
      bodyXdr: "AAAAEQAAAAEAAAAA",
    };

    const first = mapArchiveRecordToRawEvent(realRecord, realTxHash);
    const second = mapArchiveRecordToRawEvent(secondRecord, realTxHash);

    expect(first.id).not.toBe(second.id);
    expect(first.ledger).toBe(second.ledger);
    expect(first.txHash).toBe(second.txHash);
    expect(second.eventIndex).toBe(2);
  });
});

describe("compareArchiveOrder", () => {
  it("sorts by TOID ascending, then eventIndex, deterministically", () => {
    const base = mapArchiveRecordToRawEvent(
      {
        id: "16209099200970753-0002",
        ts: 1784887928,
        contract: "C_A",
        topicsXdr: [],
        bodyXdr: "AA==",
      },
      "hashA",
    );
    const earlierLedger = mapArchiveRecordToRawEvent(
      { id: "16209099200970753-0001", ts: 1784887928, contract: "C_A", topicsXdr: [], bodyXdr: "AA==" },
      "hashA",
    );
    const laterLedger = mapArchiveRecordToRawEvent(
      { id: "16734107413278721-0000", ts: 1785500413, contract: "C_B", topicsXdr: [], bodyXdr: "AA==" },
      "hashB",
    );

    const shuffled = [laterLedger, base, earlierLedger];
    shuffled.sort(compareArchiveOrder);

    expect(shuffled.map((e) => e.id)).toEqual([earlierLedger.id, base.id, laterLedger.id]);
  });

  it("is a stable total order (sorting twice yields the same result)", () => {
    const a = mapArchiveRecordToRawEvent(
      { id: "100-0000", ts: 1, contract: "C1", topicsXdr: [], bodyXdr: "AA==" },
      "h1",
    );
    const b = mapArchiveRecordToRawEvent(
      { id: "100-0000", ts: 1, contract: "C2", topicsXdr: [], bodyXdr: "AA==" },
      "h2",
    );
    const once = [b, a].sort(compareArchiveOrder);
    const twice = [...once].sort(compareArchiveOrder);
    expect(twice).toEqual(once);
    // Same toid+eventIndex, differing only by contractId — tiebreak is deterministic.
    expect(once.map((e) => e.contractId)).toEqual(["C1", "C2"]);
  });
});
