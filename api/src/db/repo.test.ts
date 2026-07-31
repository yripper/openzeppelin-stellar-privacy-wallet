/**
 * Integration tests against the local docker Postgres (see repo-root
 * `docker-compose.yml`). Skipped automatically when DATABASE_URL isn't set
 * (e.g. in an environment without docker), so `pnpm test` never hard-fails
 * on a missing DB.
 *
 * Run: `docker compose up -d postgres` then
 * `DATABASE_URL=postgres://grantfox:grantfox@localhost:5433/grantfox pnpm --filter @grantfox/api test`
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { createRepo, type IndexerRepo } from "./repo.js";
import { ctActivity, events, type NewEventRow } from "./schema.js";

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
});
