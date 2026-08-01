/**
 * TDD spec for the bootnode-protocol `getEvents`/`getLatestLedger` handler
 * (Task 9). Offline: a small in-memory `FakeBootnodeRepo` that REPLICATES
 * the real `listEventsFromLedger`/`listEventsAfterId`/`getLedgerBounds`
 * semantics (tuple ordering by (ledger, txIndex, opIndex, eventIndex),
 * cursor-not-found -> null) rather than stubbing them, so these tests prove
 * the handler's OWN decision logic (validation order, handoff/cache-miss
 * mapping), not just that it calls through to mocks. `fetchLatestLedger` is
 * injected (never hits a live network).
 *
 * Required cases per the task-9 brief: valid page, both-params error,
 * unsupported-filter error, handoff, cache miss — plus the validation-order
 * edges (endLedger/xdrFormat rejection, neither-param error, each filter
 * sub-check) and getLatestLedger.
 */
import { describe, expect, it, vi } from "vitest";
import type { EventRow } from "../../db/schema.js";
import type { EventsAfterIdQuery, EventsWindowQuery } from "../../db/repo.js";
import {
  CACHE_MISS_CODE,
  INTERNAL_ERROR_CODE,
  INVALID_PARAMS_CODE,
  RETENTION_HANDOFF_CODE,
  handleGetEvents,
  handleGetLatestLedger,
  type BootnodeHandlerDeps,
} from "./handler.js";

const ALLOWED = ["CPOOL", "CEURC", "CASP", "CREG"];

function makeRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "1-tx-0-0",
    contractId: "CPOOL",
    ledger: 1,
    ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
    txHash: "tx",
    txIndex: 0,
    opIndex: 0,
    eventIndex: 0,
    topic: ["AAAADwAAAAh0cmFuc2Zlcg=="],
    valueXdr: "AAAAAA==",
    inSuccessfulCall: true,
    ...overrides,
  };
}

function compareRows(a: EventRow, b: EventRow): number {
  return a.ledger - b.ledger || a.txIndex - b.txIndex || a.opIndex - b.opIndex || a.eventIndex - b.eventIndex;
}

/** Replicates `RepoOps`' Task 9 query methods (real tuple-ordering/cursor semantics) against an in-memory row set. */
class FakeBootnodeRepo {
  constructor(private rows: EventRow[]) {}

  async listEventsFromLedger({ contractIds, fromLedger, toLedger, limit }: EventsWindowQuery): Promise<EventRow[]> {
    return this.rows
      .filter(
        (r) => contractIds.includes(r.contractId) && r.ledger >= fromLedger && (toLedger === undefined || r.ledger <= toLedger),
      )
      .sort(compareRows)
      .slice(0, limit);
  }

  async listEventsAfterId({ contractIds, afterId, toLedger, limit }: EventsAfterIdQuery): Promise<EventRow[] | null> {
    const cursorRow = this.rows.find((r) => r.id === afterId && contractIds.includes(r.contractId));
    if (cursorRow === undefined) return null;
    return this.rows
      .filter(
        (r) =>
          contractIds.includes(r.contractId) &&
          compareRows(r, cursorRow) > 0 &&
          (toLedger === undefined || r.ledger <= toLedger),
      )
      .sort(compareRows)
      .slice(0, limit);
  }

  async getLedgerBounds(contractIds?: string[]): Promise<{ min: number; max: number } | null> {
    const scoped = contractIds !== undefined ? this.rows.filter((r) => contractIds.includes(r.contractId)) : this.rows;
    if (scoped.length === 0) return null;
    return { min: Math.min(...scoped.map((r) => r.ledger)), max: Math.max(...scoped.map((r) => r.ledger)) };
  }
}

const UPSTREAM = { id: "upstream-id", protocolVersion: 27, sequence: 5_000_000, closeTime: "1785600000" };

function makeDeps(rows: EventRow[], overrides: Partial<BootnodeHandlerDeps> = {}): BootnodeHandlerDeps {
  return {
    repo: new FakeBootnodeRepo(rows),
    allowedContractIds: ALLOWED,
    rpcUrl: "https://rpc.example",
    fetchLatestLedger: vi.fn().mockResolvedValue(UPSTREAM),
    ...overrides,
  };
}

function filtersFor(contractIds: string[], topics: string[][] = [["**"]], type = "contract") {
  return [{ type, topics, contractIds }];
}

describe("handleGetEvents", () => {
  it("valid page: startLedger request returns events ordered by chain position with a cursor to continue", async () => {
    const rows = [
      makeRow({ id: "a", ledger: 100, txIndex: 0, opIndex: 0, eventIndex: 1 }),
      makeRow({ id: "b", ledger: 100, txIndex: 0, opIndex: 0, eventIndex: 0 }),
      makeRow({ id: "c", ledger: 200, contractId: "CREG" }),
    ];
    const deps = makeDeps(rows);

    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), startLedger: 100, pagination: { limit: 10 } },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result.events.map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(outcome.result.cursor).toBe("c");
    expect(outcome.result.latestLedger).toBe(UPSTREAM.sequence);
    expect(outcome.result.latestLedgerCloseTime).toBe(UPSTREAM.closeTime);
    expect(outcome.result.oldestLedger).toBe(100);
    // Wire shape: base64-XDR topic/value passed through verbatim, camelCase field names.
    const first = outcome.result.events[0]!;
    expect(first).toEqual({
      type: "contract",
      ledger: 100,
      ledgerClosedAt: "2026-01-01T00:00:00.000Z",
      contractId: "CPOOL",
      id: "b",
      operationIndex: 0,
      transactionIndex: 0,
      txHash: "tx",
      inSuccessfulContractCall: true,
      topic: ["AAAADwAAAAh0cmFuc2Zlcg=="],
      value: "AAAAAA==",
    });
  });

  it("valid page: cursor request resumes strictly after the cursor's position", async () => {
    const rows = [
      makeRow({ id: "a", ledger: 100, eventIndex: 0 }),
      makeRow({ id: "b", ledger: 100, eventIndex: 1 }),
      makeRow({ id: "c", ledger: 100, eventIndex: 2 }),
    ];
    const deps = makeDeps(rows);

    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), pagination: { cursor: "a", limit: 10 } },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result.events.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("both-params error: startLedger AND pagination.cursor both given -> -32602", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), startLedger: 1, pagination: { cursor: "x" } },
      deps,
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: INVALID_PARAMS_CODE, message: expect.stringMatching(/not both/i) },
    });
  });

  it("neither startLedger nor pagination.cursor given -> -32602", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents({ filters: filtersFor(ALLOWED), pagination: {} }, deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected error");
    expect(outcome.error.code).toBe(INVALID_PARAMS_CODE);
  });

  it("endLedger is rejected with -32602, checked before pagination/filter validation", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: [], startLedger: 1, endLedger: 100, pagination: {} },
      deps,
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: INVALID_PARAMS_CODE, message: expect.stringMatching(/endLedger/) },
    });
  });

  it("xdrFormat is rejected with -32602, checked before pagination/filter validation", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: [], startLedger: 1, xdrFormat: "base64", pagination: {} },
      deps,
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: INVALID_PARAMS_CODE, message: expect.stringMatching(/xdrFormat/) },
    });
  });

  it("unsupported-filter error: wrong contractIds set -> -32602 'unsupported filters'", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: filtersFor(["CPOOL"]), startLedger: 1, pagination: {} },
      deps,
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: INVALID_PARAMS_CODE, message: expect.stringMatching(/unsupported filters/) },
    });
  });

  it("unsupported-filter error: contractIds set-equal ignores order", async () => {
    const rows = [makeRow({ id: "a", ledger: 1 })];
    const deps = makeDeps(rows);
    const reversed = [...ALLOWED].reverse();
    const outcome = await handleGetEvents(
      { filters: filtersFor(reversed), startLedger: 1, pagination: {} },
      deps,
    );
    expect(outcome.ok).toBe(true);
  });

  it("unsupported-filter error: wrong type", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED, [["**"]], "system"), startLedger: 1, pagination: {} },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected error");
    expect(outcome.error.message).toMatch(/unsupported filters/);
  });

  it("unsupported-filter error: wrong topics", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED, [["deposit"]]), startLedger: 1, pagination: {} },
      deps,
    );
    expect(outcome.ok).toBe(false);
  });

  it("unsupported-filter error: more than one filter", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: [...filtersFor(ALLOWED), ...filtersFor(ALLOWED)], startLedger: 1, pagination: {} },
      deps,
    );
    expect(outcome.ok).toBe(false);
  });

  it("unsupported-filter error: zero filters", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents({ filters: [], startLedger: 1, pagination: {} }, deps);
    expect(outcome.ok).toBe(false);
  });

  it("malformed params (unknown top-level field) -> -32602", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), startLedger: 1, pagination: {}, bogus: true },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected error");
    expect(outcome.error.code).toBe(INVALID_PARAMS_CODE);
  });

  it("handoff: startLedger beyond our indexed tip -> -32002 with fromLedger = ourTip + 1", async () => {
    const rows = [makeRow({ id: "a", ledger: 100 })];
    const deps = makeDeps(rows);

    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), startLedger: 101, pagination: {} },
      deps,
    );

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: RETENTION_HANDOFF_CODE,
        message: "Continue syncing on your RPC endpoint",
        data: { reason: "retention_threshold", fromLedger: 101 },
      },
    });
    // No live upstream call needed to decide a handoff.
    expect(deps.fetchLatestLedger).not.toHaveBeenCalled();
  });

  it("handoff: cursor whose next page is empty (caught up to our tip) -> -32002", async () => {
    const rows = [makeRow({ id: "a", ledger: 100 })];
    const deps = makeDeps(rows);

    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), pagination: { cursor: "a" } },
      deps,
    );

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: RETENTION_HANDOFF_CODE,
        message: "Continue syncing on your RPC endpoint",
        data: { reason: "retention_threshold", fromLedger: 101 },
      },
    });
  });

  it("handoff fromLedger is 0 when we have indexed nothing at all for the allowed set", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), startLedger: 0, pagination: {} },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected error");
    expect(outcome.error.data).toEqual({ reason: "retention_threshold", fromLedger: 0 });
  });

  it("cache miss: cursor doesn't resolve to any row in the allowed contract set -> -32004", async () => {
    const rows = [makeRow({ id: "a", ledger: 100 })];
    const deps = makeDeps(rows);

    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), pagination: { cursor: "no-such-id" } },
      deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected error");
    expect(outcome.error.code).toBe(CACHE_MISS_CODE);
  });

  it("cache miss: cursor exists but for a contract outside the allowed set", async () => {
    const rows = [makeRow({ id: "a", ledger: 100, contractId: "CNOT-ALLOWED" })];
    const deps = makeDeps(rows);

    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), pagination: { cursor: "a" } },
      deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected error");
    expect(outcome.error.code).toBe(CACHE_MISS_CODE);
  });

  it("pagination.limit caps the page size", async () => {
    const rows = [makeRow({ id: "a", ledger: 1 }), makeRow({ id: "b", ledger: 2 }), makeRow({ id: "c", ledger: 3 })];
    const deps = makeDeps(rows);

    const outcome = await handleGetEvents(
      { filters: filtersFor(ALLOWED), startLedger: 0, pagination: { limit: 2 } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result.events).toHaveLength(2);
  });

  it("pagination.limit defaults when omitted (our own bootnode-client.ts never sends one)", async () => {
    const rows = [makeRow({ id: "a", ledger: 1 })];
    const deps = makeDeps(rows);
    const outcome = await handleGetEvents({ filters: filtersFor(ALLOWED), startLedger: 0, pagination: {} }, deps);
    expect(outcome.ok).toBe(true);
  });
});

describe("handleGetLatestLedger", () => {
  it("proxies the upstream RPC's getLatestLedger result", async () => {
    const deps = makeDeps([]);
    const outcome = await handleGetLatestLedger(deps);
    expect(outcome).toEqual({
      ok: true,
      result: { id: UPSTREAM.id, protocolVersion: UPSTREAM.protocolVersion, sequence: UPSTREAM.sequence },
    });
  });

  it("propagates an upstream failure as a thrown error (transport layer maps it to -32603)", async () => {
    const deps = makeDeps([], { fetchLatestLedger: vi.fn().mockRejectedValue(new Error("upstream down")) });
    await expect(handleGetLatestLedger(deps)).rejects.toThrow("upstream down");
  });
});

describe("exported JSON-RPC error codes", () => {
  it("match the bootnode protocol's reserved codes (tools/bootnode/src/rpc.rs:17-28)", () => {
    expect(RETENTION_HANDOFF_CODE).toBe(-32002);
    expect(CACHE_MISS_CODE).toBe(-32004);
    expect(INVALID_PARAMS_CODE).toBe(-32602);
    expect(INTERNAL_ERROR_CODE).toBe(-32603);
  });
});
