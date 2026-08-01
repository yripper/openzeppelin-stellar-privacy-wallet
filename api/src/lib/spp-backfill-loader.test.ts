/**
 * TDD spec for Task 8.5's backfill loader logic (`spp-backfill-loader.ts`):
 * cursor-initialization decision table and idempotent batch insert. Offline
 * — a minimal in-memory fake repo, no real Postgres (that's covered by the
 * live docker-PG run reported in the task-8.5 report, not by this file).
 */
import { describe, expect, it } from "vitest";
import type { NewEventRow } from "../db/schema.js";
import { initSppCursor, loadBackfillEvents, SPP_STREAM_KEY } from "./spp-backfill-loader.js";

/** Minimal fake — just enough of `RepoOps` for the two functions under test. */
class FakeRepo {
  cursors = new Map<string, string>();
  events = new Map<string, NewEventRow>();
  insertEventsCalls: NewEventRow[][] = [];

  async getCursor(key: string): Promise<string | null> {
    return this.cursors.get(key) ?? null;
  }
  async setCursor(key: string, value: string): Promise<void> {
    this.cursors.set(key, value);
  }
  async insertEvents(rows: NewEventRow[]): Promise<void> {
    this.insertEventsCalls.push(rows);
    for (const row of rows) {
      if (!this.events.has(row.id)) this.events.set(row.id, row);
    }
  }
}

function makeRow(overrides: Partial<NewEventRow> = {}): NewEventRow {
  return {
    id: "1-abc-0-0",
    contractId: "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
    ledger: 1,
    ledgerClosedAt: new Date("2026-07-24T10:12:08.000Z"),
    txHash: "abc",
    txIndex: 0,
    opIndex: 0,
    eventIndex: 0,
    topic: ["AAAA"],
    valueXdr: "AAAA",
    inSuccessfulCall: true,
    ...overrides,
  };
}

describe("SPP_STREAM_KEY", () => {
  it("matches the exact stream key api/src/worker.ts's buildStreamStates() computes (spp:<pool>,<publicKeyRegistry>)", () => {
    // Literal, independently re-derived — pins the string so an accidental
    // drift from worker.ts's actual key (which isn't exported / directly
    // importable) is caught here rather than silently at runtime.
    expect(SPP_STREAM_KEY).toBe(
      "spp:CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI,CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36",
    );
  });
});

describe("initSppCursor", () => {
  it("initializes to rpc:ledger:<N+1> when no cursor exists yet", async () => {
    const repo = new FakeRepo();

    const result = await initSppCursor(repo, "spp:test", 3780200);

    expect(result).toEqual({ initialized: true, cursor: "rpc:ledger:3780201", reason: "no-existing-cursor" });
    expect(await repo.getCursor("spp:test")).toBe("rpc:ledger:3780201");
  });

  it("overwrites an existing bare bootnode-mode cursor (a raw resume token)", async () => {
    const repo = new FakeRepo();
    await repo.setCursor("spp:test", "some-opaque-bootnode-cursor-token");

    const result = await initSppCursor(repo, "spp:test", 3780500);

    expect(result).toEqual({
      initialized: true,
      cursor: "rpc:ledger:3780501",
      reason: "existing-cursor-still-bootnode-mode",
    });
    expect(await repo.getCursor("spp:test")).toBe("rpc:ledger:3780501");
  });

  it("overwrites an existing handoff: marker (still bootnode mode, per poller.ts's state machine)", async () => {
    const repo = new FakeRepo();
    await repo.setCursor("spp:test", "handoff:3780100");

    const result = await initSppCursor(repo, "spp:test", 3780500);

    expect(result.initialized).toBe(true);
    expect(result.reason).toBe("existing-cursor-still-bootnode-mode");
    expect(await repo.getCursor("spp:test")).toBe("rpc:ledger:3780501");
  });

  it("does NOT overwrite an existing rpc:-mode cursor — never regresses real worker progress", async () => {
    const repo = new FakeRepo();
    await repo.setCursor("spp:test", "rpc:cursor-from-a-real-handoff");

    const result = await initSppCursor(repo, "spp:test", 3780500);

    expect(result).toEqual({ initialized: false, cursor: "rpc:cursor-from-a-real-handoff", reason: "already-rpc-mode" });
    expect(await repo.getCursor("spp:test")).toBe("rpc:cursor-from-a-real-handoff");
  });

  it("does NOT overwrite an existing rpc:ledger:<N> cursor (bootstrapped by a prior loader run) even if N is lower", async () => {
    const repo = new FakeRepo();
    await repo.setCursor("spp:test", "rpc:ledger:3780201");

    const result = await initSppCursor(repo, "spp:test", 3780500);

    expect(result.initialized).toBe(false);
    expect(await repo.getCursor("spp:test")).toBe("rpc:ledger:3780201");
  });
});

describe("loadBackfillEvents", () => {
  it("inserts all rows and returns the count submitted", async () => {
    const repo = new FakeRepo();
    const rows = [makeRow({ id: "1-a-0-0" }), makeRow({ id: "1-a-0-1", eventIndex: 1 })];

    const count = await loadBackfillEvents(repo, rows);

    expect(count).toBe(2);
    expect(repo.events.size).toBe(2);
  });

  it("chunks large batches into multiple insertEvents calls", async () => {
    const repo = new FakeRepo();
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ id: `1-a-0-${i}`, eventIndex: i }));

    await loadBackfillEvents(repo, rows, 2);

    expect(repo.insertEventsCalls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(repo.events.size).toBe(5);
  });

  it("is idempotent — a re-run with the same rows produces no duplicates", async () => {
    const repo = new FakeRepo();
    const rows = [makeRow({ id: "1-a-0-0" }), makeRow({ id: "1-a-0-1", eventIndex: 1 })];

    await loadBackfillEvents(repo, rows);
    await loadBackfillEvents(repo, rows); // re-run, e.g. loader invoked twice

    expect(repo.events.size).toBe(2);
  });

  it("a no-op on an empty fixture", async () => {
    const repo = new FakeRepo();
    const count = await loadBackfillEvents(repo, []);
    expect(count).toBe(0);
    expect(repo.insertEventsCalls).toEqual([]);
  });
});
