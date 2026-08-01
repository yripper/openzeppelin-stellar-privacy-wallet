/**
 * Smoke test that `buildApp` correctly assembles both route sets onto one
 * Fastify instance (path collisions, both plugins mounted) — the individual
 * route/handler logic is already covered in depth by
 * `modules/activity/routes.test.ts`, `modules/bootnode/routes.test.ts`, and
 * `modules/bootnode/handler.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { buildApp } from "./app.js";

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    repo: {
      listEventsFromLedger: vi.fn().mockResolvedValue([]),
      listEventsAfterId: vi.fn().mockResolvedValue(null),
      getLedgerBounds: vi.fn().mockResolvedValue(null),
      listActivityForAccount: vi.fn().mockResolvedValue([]),
      listActivityForAccountBeforeId: vi.fn().mockResolvedValue(null),
    },
    allowedContractIds: ["C1", "C2", "C3", "C4"],
    rpcUrl: "https://rpc.example",
    logger: false,
    ...overrides,
  };
}

describe("buildApp", () => {
  let app: FastifyInstance;
  afterEach(async () => await app?.close());

  it("mounts the REST routes", async () => {
    app = buildApp(makeDeps());
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ latest_synced_ledger: 0 });
  });

  it("mounts the bootnode JSON-RPC route at POST /rpc", async () => {
    app = buildApp(
      makeDeps({
        // handleGetLatestLedger falls back to the real fetchUpstreamLatestLedger
        // when no override is injected via AppDeps -- not exercised here; this
        // just proves the route is reachable and dispatches, using getEvents
        // (whose fake repo answers deterministically without a network call).
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/rpc",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "getEvents",
        params: { filters: [], startLedger: 0, pagination: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe(-32602); // empty filters -> unsupported filters, proves dispatch reached handler.ts
  });
});
