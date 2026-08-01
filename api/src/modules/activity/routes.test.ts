/**
 * Integration test for the REST routes (`registerActivityRoutes`) —
 * `fastify.inject` against a minimal app with a fake repo (no real DB),
 * proving: wire-shape parity with `@ctd/indexer`'s handler API (field
 * names, default/max limit, base64 cursor, oldest->newest ordering) for
 * `/health` and `/contracts/:contractId/events`, and this task's own design
 * for `/accounts/:address/activity` (newest-first, keyset-paged).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountActivityBeforeIdQuery, AccountActivityQuery, EventsAfterIdQuery, EventsWindowQuery } from "../../db/repo.js";
import type { CtActivityRow, EventRow } from "../../db/schema.js";
import { registerActivityRoutes, type ActivityRepoDeps } from "./routes.js";

function makeEventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "3900251-abc-0-0",
    contractId: "CTOKEN",
    ledger: 3900251,
    ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
    txHash: "abc",
    txIndex: 0,
    opIndex: 0,
    eventIndex: 0,
    topic: ["AAAADwAAAAh0cmFuc2Zlcg=="],
    valueXdr: "AAAAAA==",
    inSuccessfulCall: true,
    ...overrides,
  };
}

function makeActivityRow(overrides: Partial<CtActivityRow> = {}): CtActivityRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    account: "GACCOUNT",
    type: "transfer",
    counterparty: "GCOUNTERPARTY",
    amount: null,
    ledger: 10,
    txHash: "abc",
    eventId: "10-abc-0-0",
    ciphertexts: {},
    ...overrides,
  };
}

function makeRepo(overrides: Partial<ActivityRepoDeps> = {}): ActivityRepoDeps {
  return {
    listEventsFromLedger: vi.fn(async (_q: EventsWindowQuery) => [] as EventRow[]),
    listEventsAfterId: vi.fn(async (_q: EventsAfterIdQuery) => null as EventRow[] | null),
    getLedgerBounds: vi.fn(async () => null as { min: number; max: number } | null),
    listActivityForAccount: vi.fn(async (_q: AccountActivityQuery) => [] as CtActivityRow[]),
    listActivityForAccountBeforeId: vi.fn(async (_q: AccountActivityBeforeIdQuery) => null as CtActivityRow[] | null),
    ...overrides,
  };
}

function buildTestApp(repo: ActivityRepoDeps): FastifyInstance {
  const app = Fastify();
  registerActivityRoutes(app, repo);
  return app;
}

describe("GET /health", () => {
  let app: FastifyInstance;
  afterEach(async () => await app?.close());

  it("returns latest_synced_ledger from the unscoped ledger bounds", async () => {
    const repo = makeRepo({ getLedgerBounds: vi.fn().mockResolvedValue({ min: 1, max: 42 }) });
    app = buildTestApp(repo);

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ latest_synced_ledger: 42 });
    expect(repo.getLedgerBounds).toHaveBeenCalledWith();
  });

  it("returns 0 when nothing has been indexed yet", async () => {
    const repo = makeRepo();
    app = buildTestApp(repo);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ latest_synced_ledger: 0 });
  });
});

describe("GET /contracts/:contractId/events", () => {
  let app: FastifyInstance;
  afterEach(async () => await app?.close());

  it("mirrors @ctd/indexer's response shape: {latestLedger, cursor, events:[{id,ledger,txHash,topic,value}]}", async () => {
    const row = makeEventRow();
    const repo = makeRepo({
      listEventsFromLedger: vi.fn().mockResolvedValue([row]),
      getLedgerBounds: vi.fn().mockResolvedValue({ min: 1, max: 3900251 }),
    });
    app = buildTestApp(repo);

    const res = await app.inject({ method: "GET", url: "/contracts/CTOKEN/events" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      latestLedger: 3900251,
      cursor: null,
      events: [{ id: row.id, ledger: row.ledger, txHash: row.txHash, topic: row.topic, value: row.valueXdr }],
    });
  });

  it("passes startLedger/endLedger/limit through to listEventsFromLedger", async () => {
    const repo = makeRepo();
    app = buildTestApp(repo);

    await app.inject({ method: "GET", url: "/contracts/CTOKEN/events?startLedger=100&endLedger=200&limit=5" });

    expect(repo.listEventsFromLedger).toHaveBeenCalledWith({
      contractIds: ["CTOKEN"],
      fromLedger: 100,
      toLedger: 200,
      limit: 6, // limit+1, over-fetched to detect a further page
    });
  });

  it("defaults limit to 200, caps at 1000", async () => {
    const repo = makeRepo();
    app = buildTestApp(repo);

    await app.inject({ method: "GET", url: "/contracts/CTOKEN/events" });
    expect(repo.listEventsFromLedger).toHaveBeenCalledWith(expect.objectContaining({ limit: 201 }));

    await app.inject({ method: "GET", url: "/contracts/CTOKEN/events?limit=999999" });
    expect(repo.listEventsFromLedger).toHaveBeenCalledWith(expect.objectContaining({ limit: 1001 }));
  });

  it("emits a base64 cursor of the last row's id when there's a further page (over-fetch by 1 trims it off)", async () => {
    const rows = [makeEventRow({ id: "a" }), makeEventRow({ id: "b" })];
    const repo = makeRepo({ listEventsFromLedger: vi.fn().mockResolvedValue(rows) });
    app = buildTestApp(repo);

    const res = await app.inject({ method: "GET", url: "/contracts/CTOKEN/events?limit=1" });
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe("a");
    expect(body.cursor).toBe(Buffer.from("a", "utf8").toString("base64"));
  });

  it("cursor query param resolves via listEventsAfterId, decoded from base64", async () => {
    const repo = makeRepo({ listEventsAfterId: vi.fn().mockResolvedValue([]) });
    app = buildTestApp(repo);

    const cursor = Buffer.from("3900251-abc-0-0", "utf8").toString("base64");
    await app.inject({ method: "GET", url: `/contracts/CTOKEN/events?cursor=${encodeURIComponent(cursor)}` });

    expect(repo.listEventsAfterId).toHaveBeenCalledWith({
      contractIds: ["CTOKEN"],
      afterId: "3900251-abc-0-0",
      toLedger: undefined,
      limit: 201,
    });
  });

  it("400 INVALID_ARGUMENT when the cursor doesn't resolve to a row", async () => {
    const repo = makeRepo({ listEventsAfterId: vi.fn().mockResolvedValue(null) });
    app = buildTestApp(repo);

    const res = await app.inject({ method: "GET", url: "/contracts/CTOKEN/events?cursor=bm90LWEtcmVhbC1pZA==" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "INVALID_ARGUMENT", message: "Invalid cursor" } });
  });

  it("400 INVALID_ARGUMENT on a non-integer startLedger", async () => {
    const repo = makeRepo();
    app = buildTestApp(repo);

    const res = await app.inject({ method: "GET", url: "/contracts/CTOKEN/events?startLedger=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ARGUMENT");
  });
});

describe("GET /accounts/:address/activity", () => {
  let app: FastifyInstance;
  afterEach(async () => await app?.close());

  it("returns normalized ct_activity rows, newest first, keyset-paged", async () => {
    const row = makeActivityRow();
    const repo = makeRepo({ listActivityForAccount: vi.fn().mockResolvedValue([row]) });
    app = buildTestApp(repo);

    const res = await app.inject({ method: "GET", url: "/accounts/GACCOUNT/activity" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      cursor: null,
      activity: [
        {
          id: row.id,
          account: row.account,
          type: row.type,
          counterparty: row.counterparty,
          amount: row.amount,
          ledger: row.ledger,
          txHash: row.txHash,
          eventId: row.eventId,
          ciphertexts: row.ciphertexts,
        },
      ],
    });
    expect(repo.listActivityForAccount).toHaveBeenCalledWith({ account: "GACCOUNT", limit: 201 });
  });

  it("cursor query param resolves via listActivityForAccountBeforeId", async () => {
    const repo = makeRepo({ listActivityForAccountBeforeId: vi.fn().mockResolvedValue([]) });
    app = buildTestApp(repo);

    const cursor = Buffer.from("00000000-0000-0000-0000-000000000001", "utf8").toString("base64");
    await app.inject({ method: "GET", url: `/accounts/GACCOUNT/activity?cursor=${encodeURIComponent(cursor)}` });

    expect(repo.listActivityForAccountBeforeId).toHaveBeenCalledWith({
      account: "GACCOUNT",
      beforeId: "00000000-0000-0000-0000-000000000001",
      limit: 201,
    });
  });

  it("400 INVALID_ARGUMENT when the cursor doesn't resolve", async () => {
    const repo = makeRepo({ listActivityForAccountBeforeId: vi.fn().mockResolvedValue(null) });
    app = buildTestApp(repo);

    const res = await app.inject({ method: "GET", url: "/accounts/GACCOUNT/activity?cursor=Ym9ndXM=" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "INVALID_ARGUMENT", message: "Invalid cursor" } });
  });
});
