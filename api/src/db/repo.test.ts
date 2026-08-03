/**
 * Integration tests against the local docker Postgres (see repo-root
 * `docker-compose.yml`). Skipped automatically when DATABASE_URL isn't set
 * (e.g. in an environment without docker), so `pnpm test` never hard-fails
 * on a missing DB.
 *
 * Run: `docker compose up -d postgres` then
 * `DATABASE_URL=postgres://grantfox:grantfox@localhost:5433/grantfox pnpm --filter @privacy-wallet/api test`
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { createRepo, type IndexerRepo } from "./repo.js";
import { ctActivity, events, type NewCtActivityRow, type NewEventRow } from "./schema.js";

const DATABASE_URL = process.env.DATABASE_URL;

function makeEvent(overrides: Partial<NewEventRow> = {}): NewEventRow {
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

function makeActivity(overrides: Partial<NewCtActivityRow> = {}): NewCtActivityRow {
  return {
    account: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    type: "transfer",
    counterparty: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: null,
    ledger: 1,
    txHash: "abc",
    eventId: "1-abc-0-0",
    ciphertexts: {},
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)("IndexerRepo (integration, local docker postgres)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let repo: IndexerRepo;

  beforeAll(() => {
    ({ db, pool } = createDb(DATABASE_URL!));
    repo = createRepo(db);
  });

  beforeEach(async () => {
    // Truncate between tests so each test owns a clean table set.
    await db.execute(
      sql`truncate table events, ct_activity, cursors, bootnode_pages restart identity cascade`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("insertEvents is idempotent (on-conflict-do-nothing by id)", async () => {
    const row = makeEvent();
    await repo.insertEvents([row]);
    // Re-insert the same id with a different payload; the original must win.
    await repo.insertEvents([{ ...row, valueXdr: "CHANGED" }]);

    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valueXdr).toBe("AAAAAA==");
  });

  it("insertEvents batches multiple distinct rows", async () => {
    await repo.insertEvents([
      makeEvent({ id: "1-abc-0-0" }),
      makeEvent({ id: "1-abc-0-1", eventIndex: 1 }),
    ]);
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(2);
  });

  it("cursor get/set round-trip, with update-in-place semantics", async () => {
    expect(await repo.getCursor("events:rpc")).toBeNull();

    await repo.setCursor("events:rpc", "cursor-1");
    expect(await repo.getCursor("events:rpc")).toBe("cursor-1");

    await repo.setCursor("events:rpc", "cursor-2");
    expect(await repo.getCursor("events:rpc")).toBe("cursor-2");
  });

  it("insertCtActivity inserts normalized rows", async () => {
    await repo.insertEvents([makeEvent()]);
    await repo.insertCtActivity([
      {
        account: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        type: "transfer",
        counterparty: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: null,
        ledger: 1,
        txHash: "abc",
        eventId: "1-abc-0-0",
        ciphertexts: { c1: "x", c2: "y" },
      },
    ]);

    const rows = await db.select().from(ctActivity);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBeNull();
    expect(rows[0]?.id).toBeTruthy();
  });

  it("bootnode_pages insert/get round-trip", async () => {
    await repo.insertBootnodePage({
      cursorIn: "cursor-0",
      request: { limit: 100 },
      response: { events: [] },
      cursorOut: "cursor-1",
      lastEventLedger: 42,
    });

    const page = await repo.getBootnodePage("cursor-0");
    expect(page).not.toBeNull();
    expect(page?.cursorOut).toBe("cursor-1");
    expect(page?.lastEventLedger).toBe(42);

    expect(await repo.getBootnodePage("missing")).toBeNull();
  });

  it("withTransaction commits on success and rolls back on throw", async () => {
    await repo.withTransaction(async (tx) => {
      await tx.setCursor("tx-key", "committed");
    });
    expect(await repo.getCursor("tx-key")).toBe("committed");

    await expect(
      repo.withTransaction(async (tx) => {
        await tx.setCursor("tx-key", "rolled-back");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await repo.getCursor("tx-key")).toBe("committed");
  });

  describe("listEventsFromLedger / listEventsAfterId (Task 9: REST events + bootnode getEvents)", () => {
    const POOL = "CPOOL0000000000000000000000000000000000000000000000000";
    const REGISTRY = "CREG00000000000000000000000000000000000000000000000000";
    const OTHER = "COTHER000000000000000000000000000000000000000000000000";

    // Deliberately mixed ledger digit-widths (9 vs 10) so a naive `ORDER BY id`
    // string-sort (id = "${ledger}-...") would misorder these — proves
    // ordering is by the real (ledger, txIndex, opIndex, eventIndex) tuple.
    beforeEach(async () => {
      await repo.insertEvents([
        makeEvent({ id: "e-pool-1", contractId: POOL, ledger: 999_999_998, txHash: "t1", opIndex: 0, eventIndex: 0 }),
        makeEvent({ id: "e-pool-2", contractId: POOL, ledger: 999_999_998, txHash: "t1", opIndex: 0, eventIndex: 1 }),
        makeEvent({ id: "e-pool-3", contractId: POOL, ledger: 1_000_000_000, txHash: "t2", opIndex: 0, eventIndex: 0 }),
        makeEvent({ id: "e-reg-1", contractId: REGISTRY, ledger: 999_999_999, txHash: "t3", opIndex: 0, eventIndex: 0 }),
        makeEvent({ id: "e-other-1", contractId: OTHER, ledger: 1, txHash: "t4", opIndex: 0, eventIndex: 0 }),
      ]);
    });

    it("listEventsFromLedger: filters by contractIds + fromLedger, orders by chain position (not string id)", async () => {
      const rows = await repo.listEventsFromLedger({ contractIds: [POOL, REGISTRY], fromLedger: 999_999_998, limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(["e-pool-1", "e-pool-2", "e-reg-1", "e-pool-3"]);
    });

    it("listEventsFromLedger: respects toLedger (inclusive) and limit", async () => {
      const rows = await repo.listEventsFromLedger({
        contractIds: [POOL, REGISTRY],
        fromLedger: 0,
        toLedger: 999_999_998,
        limit: 1,
      });
      expect(rows.map((r) => r.id)).toEqual(["e-pool-1"]);
    });

    it("listEventsFromLedger: never returns a row outside contractIds", async () => {
      const rows = await repo.listEventsFromLedger({ contractIds: [POOL], fromLedger: 0, limit: 10 });
      expect(rows.every((r) => r.contractId === POOL)).toBe(true);
      expect(rows).toHaveLength(3);
    });

    it("listEventsAfterId: pages strictly after the given id's chain position", async () => {
      const rows = await repo.listEventsAfterId({ contractIds: [POOL, REGISTRY], afterId: "e-pool-2", limit: 10 });
      expect(rows?.map((r) => r.id)).toEqual(["e-reg-1", "e-pool-3"]);
    });

    it("listEventsAfterId: returns null when afterId doesn't exist among contractIds' rows", async () => {
      expect(await repo.listEventsAfterId({ contractIds: [POOL], afterId: "no-such-id", limit: 10 })).toBeNull();
      // exists, but for a DIFFERENT contract than requested -> also unresolvable
      expect(await repo.listEventsAfterId({ contractIds: [POOL], afterId: "e-reg-1", limit: 10 })).toBeNull();
    });

    it("getLedgerBounds: min/max scoped to contractIds", async () => {
      expect(await repo.getLedgerBounds([POOL])).toEqual({ min: 999_999_998, max: 1_000_000_000 });
      expect(await repo.getLedgerBounds([REGISTRY])).toEqual({ min: 999_999_999, max: 999_999_999 });
    });

    it("getLedgerBounds: unscoped (no contractIds) covers every row", async () => {
      expect(await repo.getLedgerBounds()).toEqual({ min: 1, max: 1_000_000_000 });
    });

    it("getLedgerBounds: null when nothing matches", async () => {
      expect(await repo.getLedgerBounds(["CNOPE0000000000000000000000000000000000000000000000000"])).toBeNull();
    });
  });

  describe("listActivityForAccount / listActivityForAccountBeforeId (Task 9: account activity feed)", () => {
    const ACCOUNT = "GACCOUNT0000000000000000000000000000000000000000000000000000000";
    const OTHER_ACCOUNT = "GOTHER00000000000000000000000000000000000000000000000000000000";

    beforeEach(async () => {
      await repo.insertCtActivity([
        makeActivity({ account: ACCOUNT, ledger: 1, eventId: "a-1" }),
        makeActivity({ account: ACCOUNT, ledger: 3, eventId: "a-3" }),
        makeActivity({ account: ACCOUNT, ledger: 2, eventId: "a-2" }),
        makeActivity({ account: OTHER_ACCOUNT, ledger: 5, eventId: "a-other" }),
      ]);
    });

    it("listActivityForAccount: newest ledger first, scoped to account", async () => {
      const rows = await repo.listActivityForAccount({ account: ACCOUNT, limit: 10 });
      expect(rows.map((r) => r.eventId)).toEqual(["a-3", "a-2", "a-1"]);
      expect(rows.every((r) => r.account === ACCOUNT)).toBe(true);
    });

    it("listActivityForAccount: respects limit", async () => {
      const rows = await repo.listActivityForAccount({ account: ACCOUNT, limit: 1 });
      expect(rows.map((r) => r.eventId)).toEqual(["a-3"]);
    });

    it("listActivityForAccountBeforeId: pages strictly before (older than) the given row", async () => {
      const [newest] = await repo.listActivityForAccount({ account: ACCOUNT, limit: 1 });
      const rows = await repo.listActivityForAccountBeforeId({ account: ACCOUNT, beforeId: newest!.id, limit: 10 });
      expect(rows?.map((r) => r.eventId)).toEqual(["a-2", "a-1"]);
    });

    it("listActivityForAccountBeforeId: null when beforeId doesn't exist for that account", async () => {
      expect(
        await repo.listActivityForAccountBeforeId({ account: ACCOUNT, beforeId: "00000000-0000-0000-0000-000000000000", limit: 10 }),
      ).toBeNull();
      const [otherRow] = await repo.listActivityForAccount({ account: OTHER_ACCOUNT, limit: 1 });
      // exists, but belongs to a DIFFERENT account than requested -> unresolvable
      expect(await repo.listActivityForAccountBeforeId({ account: ACCOUNT, beforeId: otherRow!.id, limit: 10 })).toBeNull();
    });
  });
});
