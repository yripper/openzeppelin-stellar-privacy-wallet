/**
 * Integration test for the JSON-RPC transport (`registerBootnodeRoutes`) —
 * `fastify.inject` against a minimal app with a fake `handler.ts` deps
 * object (no real DB/network), proving the envelope wiring: method
 * dispatch, `id` echo, result/error shape, and the transport-level cases
 * `handler.ts` doesn't own (unknown method, malformed body, unexpected
 * thrown error -> `-32603`).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "../../db/schema.js";
import type { EventsAfterIdQuery, EventsWindowQuery } from "../../db/repo.js";
import type { BootnodeHandlerDeps } from "./handler.js";
import { registerBootnodeRoutes } from "./routes.js";

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

function buildTestApp(deps: BootnodeHandlerDeps): FastifyInstance {
  const app = Fastify();
  registerBootnodeRoutes(app, deps);
  return app;
}

function makeDeps(overrides: Partial<BootnodeHandlerDeps> = {}): BootnodeHandlerDeps {
  const repo = {
    listEventsFromLedger: vi.fn(async (_q: EventsWindowQuery) => [] as EventRow[]),
    listEventsAfterId: vi.fn(async (_q: EventsAfterIdQuery) => null as EventRow[] | null),
    getLedgerBounds: vi.fn(async () => null as { min: number; max: number } | null),
  };
  return {
    repo,
    allowedContractIds: ALLOWED,
    rpcUrl: "https://rpc.example",
    fetchLatestLedger: vi.fn().mockResolvedValue({ id: "x", protocolVersion: 27, sequence: 100, closeTime: "1" }),
    ...overrides,
  };
}

describe("POST /rpc", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("dispatches getLatestLedger and echoes the request id", async () => {
    const deps = makeDeps();
    app = buildTestApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: { jsonrpc: "2.0", id: 7, method: "getLatestLedger", params: {} },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { id: "x", protocolVersion: 27, sequence: 100 },
    });
  });

  it("dispatches getEvents and forwards params to handleGetEvents", async () => {
    const rows = [makeRow({ id: "a", ledger: 5 })];
    const deps = makeDeps({
      repo: {
        listEventsFromLedger: vi.fn(async () => rows),
        listEventsAfterId: vi.fn(async () => null),
        getLedgerBounds: vi.fn(async () => ({ min: 5, max: 5 })),
      },
    });
    app = buildTestApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: {
        jsonrpc: "2.0",
        id: "abc",
        method: "getEvents",
        params: {
          filters: [{ type: "contract", topics: [["**"]], contractIds: ALLOWED }],
          startLedger: 5,
          pagination: {},
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("abc");
    expect(body.result.cursor).toBe("a");
    expect(body.result.events).toHaveLength(1);
  });

  it("returns a JSON-RPC error (still HTTP 200) for an invalid getEvents request", async () => {
    const deps = makeDeps();
    app = buildTestApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: { jsonrpc: "2.0", id: 1, method: "getEvents", params: { filters: [], pagination: {} } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error.code).toBe(-32602);
    expect(body.result).toBeUndefined();
  });

  it("unknown method -> -32601, still HTTP 200", async () => {
    const deps = makeDeps();
    app = buildTestApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: { jsonrpc: "2.0", id: 1, method: "notAMethod", params: {} },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toEqual({ code: -32601, message: "method not found: notAMethod" });
  });

  it("malformed body (no method) -> -32600 Invalid Request", async () => {
    const deps = makeDeps();
    app = buildTestApp(deps);

    const res = await app.inject({ method: "POST", url: "/rpc", payload: { jsonrpc: "2.0", id: 1 } });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toEqual({ code: -32600, message: "Invalid Request" });
  });

  it("an unexpected thrown error (e.g. DB unreachable) maps to -32603, not a raw 500", async () => {
    const deps = makeDeps({
      fetchLatestLedger: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    app = buildTestApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: { jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toEqual({ code: -32603, message: "ECONNREFUSED" });
  });

  it("echoes a null id when the request omits one", async () => {
    const deps = makeDeps();
    app = buildTestApp(deps);

    const res = await app.inject({ method: "POST", url: "/rpc", payload: { jsonrpc: "2.0", method: "getLatestLedger" } });

    expect(res.json().id).toBeNull();
  });
});
