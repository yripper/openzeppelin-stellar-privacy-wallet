/**
 * TDD spec for the indexer poller (Task 7). Covers the five invariants from
 * the task brief:
 *   1. batch insert + cursor advance happen in ONE transaction (a crash
 *      between the two leaves neither committed).
 *   2. the cursor still advances past a page whose events were all filtered
 *      out server-side (empty `events`, non-null `nextCursor`).
 *   3. a re-poll resumes from the stored cursor and never produces a
 *      duplicate `events.id` (on-conflict-do-nothing).
 *   4. a bootnode retention handoff persists a `handoff:<fromLedger>`
 *      cursor marker and switches the stream to the RPC source at
 *      `fromLedger` — and that switch survives a fresh `StreamSource`
 *      instance (i.e. a worker restart), because the mode lives in the
 *      persisted cursor string, not in-memory.
 *   5. one stream throwing does not stop `pollStreams` from completing the
 *      others.
 *
 * `FakeRepo` below is a minimal in-memory stand-in for `IndexerRepo` with
 * REAL staged-commit/rollback transaction semantics (not just "call the
 * functions") — `withTransaction` only writes its staged state back to the
 * committed state if the callback resolves. This is what makes invariant 1's
 * test an actual proof of atomicity rather than a tautology: the injected
 * cursor-write failure happens strictly after the insert has already been
 * staged, and the assertion is that BOTH the insert and the cursor write are
 * gone afterwards, not just that the cursor write itself failed.
 *
 * A second, DB-backed version of invariant 1 (`describe.skipIf(!DATABASE_URL)`)
 * exercises the same claim against the real Postgres transaction machinery
 * from Task 5 (`api/src/db/repo.ts`), per the task brief's "docker-PG
 * integration test for invariant 1 is a plus".
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client.js";
import { createRepo, type IndexerRepo, type RepoOps } from "../../db/repo.js";
import { events, type NewEventRow } from "../../db/schema.js";
import type { EventsPage, FetchRpcEventsOptions, RawEvent } from "../../lib/soroban-events.js";
import type { FetchBootnodeEventsOptions } from "../../lib/bootnode-client.js";
import {
  makeBootnodeThenRpcSource,
  makeRpcSource,
  pollStream,
  pollStreams,
  type StreamSource,
} from "./poller.js";

function makeRawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: "1-abc-0-0",
    contractId: "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH",
    ledger: 1,
    ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
    txHash: "abc",
    txIndex: 0,
    opIndex: 0,
    eventIndex: 0,
    topic: ["transfer"],
    valueXdr: "AAAAAA==",
    inSuccessfulCall: true,
    ...overrides,
  };
}

interface FakeState {
  events: Map<string, NewEventRow>;
  cursors: Map<string, string>;
}

function cloneState(state: FakeState): FakeState {
  return { events: new Map(state.events), cursors: new Map(state.cursors) };
}

function buildOps(state: FakeState, failOnSetCursorFor: string | undefined): RepoOps {
  return {
    async insertEvents(rows) {
      for (const row of rows) {
        if (!state.events.has(row.id)) state.events.set(row.id, row);
      }
    },
    async getCursor(key) {
      return state.cursors.get(key) ?? null;
    },
    async setCursor(key, value) {
      if (key === failOnSetCursorFor) {
        throw new Error(`simulated crash setting cursor for "${key}"`);
      }
      state.cursors.set(key, value);
    },
    async insertCtActivity() {
      throw new Error("insertCtActivity is not exercised by poller tests");
    },
    async insertBootnodePage() {
      throw new Error("insertBootnodePage is not exercised by poller tests");
    },
    async getBootnodePage() {
      return null;
    },
  };
}

/** In-memory `IndexerRepo` with real stage/commit/rollback transaction semantics. */
class FakeRepo implements IndexerRepo {
  private state: FakeState = { events: new Map(), cursors: new Map() };
  /** When set, `setCursor` for this key throws INSIDE a transaction — simulates a crash after the insert has already been staged. */
  failOnSetCursorFor: string | undefined;

  insertEvents(rows: NewEventRow[]): Promise<void> {
    return buildOps(this.state, undefined).insertEvents(rows);
  }
  getCursor(key: string): Promise<string | null> {
    return buildOps(this.state, undefined).getCursor(key);
  }
  setCursor(key: string, value: string): Promise<void> {
    return buildOps(this.state, undefined).setCursor(key, value);
  }
  insertCtActivity(): Promise<void> {
    throw new Error("insertCtActivity is not exercised by poller tests");
  }
  insertBootnodePage(): Promise<void> {
    throw new Error("insertBootnodePage is not exercised by poller tests");
  }
  getBootnodePage(): Promise<null> {
    return Promise.resolve(null);
  }

  async withTransaction<T>(fn: (repo: RepoOps) => Promise<T>): Promise<T> {
    const staged = cloneState(this.state);
    const result = await fn(buildOps(staged, this.failOnSetCursorFor));
    // Only reached if `fn` resolved — a throw above leaves `this.state` untouched.
    this.state = staged;
    return result;
  }

  get eventIds(): string[] {
    return [...this.state.events.keys()];
  }
  get eventCount(): number {
    return this.state.events.size;
  }
}

describe("pollStream — invariant 1: batch insert + cursor advance in one transaction", () => {
  it("rolls back BOTH the insert and the cursor write when the cursor write fails mid-transaction", async () => {
    const repo = new FakeRepo();
    repo.failOnSetCursorFor = "ct:test";
    const source: StreamSource = {
      fetchPage: async () => ({ events: [makeRawEvent({ id: "1-abc-0-0" })], nextCursor: "cursor-1" }),
    };

    await expect(pollStream(source, repo, "ct:test")).rejects.toThrow(/simulated crash/);

    // Not just "the cursor is unset" (trivially true if setCursor threw) — the
    // insert that happened BEFORE the throw must also be gone, proving the
    // whole page was rolled back as one unit, not partially applied.
    expect(await repo.getCursor("ct:test")).toBeNull();
    expect(repo.eventCount).toBe(0);
  });
});

describe("pollStream — invariant 2: cursor advances past a fully-filtered page", () => {
  it("persists the next cursor even when the page has zero events", async () => {
    const repo = new FakeRepo();
    const source: StreamSource = {
      fetchPage: async () => ({ events: [], nextCursor: "cursor-2" }),
    };

    await pollStream(source, repo, "ct:filtered");

    expect(await repo.getCursor("ct:filtered")).toBe("cursor-2");
    expect(repo.eventCount).toBe(0);
  });
});

describe("pollStream — invariant 3: resume from stored cursor, no duplicate events.id", () => {
  it("passes the stored cursor into the next fetch and dedupes a re-served page", async () => {
    const repo = new FakeRepo();
    const eventA = makeRawEvent({ id: "1-a-0-0" });
    const eventB = makeRawEvent({ id: "2-b-0-0" });
    const seenCursors: Array<string | null> = [];
    const source: StreamSource = {
      fetchPage: async (cursor) => {
        seenCursors.push(cursor);
        if (cursor === null) return { events: [eventA], nextCursor: "cursor-1" };
        return { events: [eventB], nextCursor: "cursor-2" };
      },
    };

    await pollStream(source, repo, "ct:resume");
    await pollStream(source, repo, "ct:resume");

    expect(seenCursors).toEqual([null, "cursor-1"]);
    expect(repo.eventIds.sort()).toEqual(["1-a-0-0", "2-b-0-0"]);

    // A third poll that re-serves the already-ingested page (e.g. an
    // overlapping/at-least-once resume) must not create a duplicate row.
    const repeatingSource: StreamSource = {
      fetchPage: async () => ({ events: [eventB], nextCursor: "cursor-2" }),
    };
    await pollStream(repeatingSource, repo, "ct:resume");

    expect(repo.eventCount).toBe(2);
  });
});

describe("pollStream — invariant 4: bootnode handoff switches the stream to RPC at fromLedger", () => {
  it("persists a handoff marker, then a FRESH source instance resumes via RPC at fromLedger", async () => {
    const repo = new FakeRepo();
    const fetchBootnode = vi.fn(
      async (
        _url: string,
        _opts: FetchBootnodeEventsOptions,
      ): Promise<EventsPage | { handoff: { fromLedger: number } }> => ({
        handoff: { fromLedger: 3800123 },
      }),
    );
    const fetchEvents = vi.fn(
      async (_url: string, _opts: FetchRpcEventsOptions): Promise<EventsPage> => ({
        events: [makeRawEvent({ id: "post-handoff-1" })],
        latestLedger: 3800200,
        cursor: "rpc-cursor-1",
        oldestLedger: 3800000,
      }),
    );
    const sourceConfig = {
      bootnodeUrl: "https://bootnode.example",
      rpcUrl: "https://rpc.example",
      contractIds: ["POOL", "REGISTRY"],
      startLedger: 3773948,
      fetchBootnode,
      fetchEvents,
    };

    const firstPollSource = makeBootnodeThenRpcSource(sourceConfig);
    await pollStream(firstPollSource, repo, "spp:test");

    expect(await repo.getCursor("spp:test")).toBe("handoff:3800123");
    expect(repo.eventCount).toBe(0);
    expect(fetchEvents).not.toHaveBeenCalled();

    // Simulate a worker restart: a brand-new StreamSource, with no in-memory
    // state — only the persisted cursor string tells it to use RPC now.
    const restartedSource = makeBootnodeThenRpcSource(sourceConfig);
    await pollStream(restartedSource, repo, "spp:test");

    expect(fetchEvents).toHaveBeenCalledTimes(1);
    const [, rpcOpts] = fetchEvents.mock.calls[0]!;
    expect(rpcOpts).toMatchObject({ startLedger: 3800123, contractIds: ["POOL", "REGISTRY"] });
    expect(rpcOpts).not.toHaveProperty("cursor");
    expect(repo.eventCount).toBe(1);
    expect(await repo.getCursor("spp:test")).toBe("rpc:rpc-cursor-1");

    // And a THIRD poll, again via a fresh source instance, must stay on RPC
    // (resuming from the persisted rpc cursor) rather than falling back to
    // the bootnode.
    const thirdSource = makeBootnodeThenRpcSource(sourceConfig);
    fetchBootnode.mockClear();
    fetchEvents.mockClear();
    fetchEvents.mockResolvedValueOnce({
      events: [],
      latestLedger: 3800300,
      cursor: "rpc-cursor-2",
      oldestLedger: 3800000,
    });
    await pollStream(thirdSource, repo, "spp:test");

    expect(fetchBootnode).not.toHaveBeenCalled();
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    const [, rpcOpts2] = fetchEvents.mock.calls[0]!;
    expect(rpcOpts2).toMatchObject({ cursor: "rpc-cursor-1" });
    expect(await repo.getCursor("spp:test")).toBe("rpc:rpc-cursor-2");
  });
});

describe("pollStreams — invariant 5: per-stream error isolation", () => {
  it("one stream throwing does not prevent the other from completing", async () => {
    const repo = new FakeRepo();
    const failingSource: StreamSource = {
      fetchPage: async () => {
        throw new Error("stream A exploded");
      },
    };
    const okSource: StreamSource = {
      fetchPage: async () => ({ events: [makeRawEvent({ id: "ok-1" })], nextCursor: "cursor-ok" }),
    };

    const outcomes = await pollStreams(
      [
        { streamKey: "a:fails", source: failingSource },
        { streamKey: "b:ok", source: okSource },
      ],
      repo,
    );

    expect(outcomes).toEqual([
      { streamKey: "a:fails", ok: false, error: expect.any(Error) },
      { streamKey: "b:ok", ok: true },
    ]);
    expect(await repo.getCursor("a:fails")).toBeNull();
    expect(await repo.getCursor("b:ok")).toBe("cursor-ok");
    expect(repo.eventCount).toBe(1);
  });

  it("skips streams not yet started once shouldStop() returns true (review fix: cheap shutdown-responsiveness check between streams, checked between iterations only — never mid-flight)", async () => {
    const repo = new FakeRepo();
    const calls: string[] = [];
    const firstSource: StreamSource = {
      fetchPage: async () => {
        calls.push("first");
        return { events: [], nextCursor: "cursor-1" };
      },
    };
    const secondSource: StreamSource = {
      fetchPage: async () => {
        calls.push("second"); // must NOT run: shouldStop() flips true after the first stream completes
        return { events: [], nextCursor: "cursor-2" };
      },
    };

    let stop = false;
    const outcomes = await pollStreams(
      [
        { streamKey: "first", source: firstSource },
        { streamKey: "second", source: secondSource },
      ],
      repo,
      () => stop,
    );
    // Nothing set `stop` in this run, so both streams should still run —
    // sanity check that a shouldStop that never fires changes nothing.
    expect(calls).toEqual(["first", "second"]);
    expect(outcomes).toHaveLength(2);

    calls.length = 0;
    stop = false;
    const stoppingFirstSource: StreamSource = {
      fetchPage: async () => {
        calls.push("first");
        stop = true; // simulate a shutdown signal arriving while the first stream was in flight
        return { events: [], nextCursor: "cursor-1" };
      },
    };
    const outcomes2 = await pollStreams(
      [
        { streamKey: "first", source: stoppingFirstSource },
        { streamKey: "second", source: secondSource },
      ],
      repo,
      () => stop,
    );

    expect(calls).toEqual(["first"]); // second never started
    expect(outcomes2).toEqual([{ streamKey: "first", ok: true }]);
  });
});

describe("makeRpcSource", () => {
  it("starts from the configured startLedger, then resumes from the returned cursor", async () => {
    const fetchEvents = vi
      .fn()
      .mockResolvedValueOnce({
        events: [],
        latestLedger: 100,
        cursor: "cursor-a",
        oldestLedger: 1,
      } satisfies EventsPage)
      .mockResolvedValueOnce({
        events: [],
        latestLedger: 200,
        cursor: "cursor-b",
        oldestLedger: 1,
      } satisfies EventsPage);
    const source = makeRpcSource({
      rpcUrl: "https://rpc.example",
      contractIds: ["C1"],
      startLedger: 42,
      fetchEvents,
    });

    const first = await source.fetchPage(null);
    expect(first.nextCursor).toBe("cursor-a");
    expect(fetchEvents.mock.calls[0]![1]).toMatchObject({ startLedger: 42, contractIds: ["C1"] });

    const second = await source.fetchPage("cursor-a");
    expect(second.nextCursor).toBe("cursor-b");
    expect(fetchEvents.mock.calls[1]![1]).toMatchObject({ cursor: "cursor-a" });
  });

  it("falls back to a ledger-number resume token when the source returns a null cursor", async () => {
    const fetchEvents = vi.fn().mockResolvedValueOnce({
      events: [],
      latestLedger: 555,
      cursor: null,
      oldestLedger: 1,
    } satisfies EventsPage);
    const source = makeRpcSource({
      rpcUrl: "https://rpc.example",
      contractIds: ["C1"],
      startLedger: 1,
      fetchEvents,
    });

    const page = await source.fetchPage(null);
    expect(page.nextCursor).toBe("ledger:556");

    fetchEvents.mockResolvedValueOnce({
      events: [],
      latestLedger: 600,
      cursor: "cursor-z",
      oldestLedger: 1,
    } satisfies EventsPage);
    await source.fetchPage(page.nextCursor);
    expect(fetchEvents.mock.calls[1]![1]).toMatchObject({ startLedger: 556 });
  });
});

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("pollStream — invariant 1 (integration, real Postgres)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let repo: IndexerRepo;

  beforeAll(() => {
    ({ db, pool } = createDb(DATABASE_URL!));
    repo = createRepo(db);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table events, ct_activity, cursors, bootnode_pages restart identity cascade`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rolls back the whole page against real Postgres when a row violates a DB constraint", async () => {
    // `ledger` is NOT NULL in the schema; force a real constraint violation
    // partway through the transaction so we can prove the repo-level
    // rollback (not the fake's) also protects pollStream's page+cursor unit.
    const badEvent: RawEvent = {
      ...makeRawEvent({ id: "bad-1" }),
      ledger: null as unknown as number,
    };
    const source: StreamSource = {
      fetchPage: async () => ({ events: [badEvent], nextCursor: "cursor-bad" }),
    };

    await expect(pollStream(source, repo, "integration:crash")).rejects.toThrow();

    const rows = await db.select().from(events);
    expect(rows).toHaveLength(0);
    expect(await repo.getCursor("integration:crash")).toBeNull();
  });
});
