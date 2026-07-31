import { afterEach, describe, expect, it, vi } from "vitest";
import { BootnodeCacheMissError, fetchBootnodeEvents } from "./bootnode-client.js";
import { naturalEventId } from "./soroban-events.js";

const CONTRACT_ID = "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH";
const URL = "https://bootnode.example/rpc";

function jsonRpcResult(result: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, result };
}

function jsonRpcError(error: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, error };
}

function mockFetchOnce(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeBootnodeEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "contract",
    ledger: 3900251,
    ledgerClosedAt: "2026-07-30T12:00:00Z",
    contractId: CONTRACT_ID,
    id: "0004100553739857920-0000000003",
    operationIndex: 0,
    transactionIndex: 2,
    txHash: "a1b2c3d4e5f6",
    inSuccessfulContractCall: true,
    topic: ["AAAADwAAAAh0cmFuc2Zlcg=="],
    value: "AAAAAA==",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBootnodeEvents", () => {
  it("POSTs a JSON-RPC 2.0 getEvents request in the bootnode's wire shape", async () => {
    const fetchMock = mockFetchOnce(
      jsonRpcResult({
        events: [],
        latestLedger: 100,
        latestLedgerCloseTime: "t",
        oldestLedger: 1,
        oldestLedgerCloseTime: "t",
        cursor: "c",
      }),
    );

    await fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], startLedger: 42 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(URL);
    expect(init.method).toBe("POST");
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        filters: [{ type: "contract", topics: [["**"]], contractIds: [CONTRACT_ID] }],
        pagination: {},
        startLedger: 42,
      },
    });
  });

  it("puts cursor under params.pagination.cursor and omits startLedger", async () => {
    const fetchMock = mockFetchOnce(
      jsonRpcResult({
        events: [],
        latestLedger: 100,
        latestLedgerCloseTime: "t",
        oldestLedger: 1,
        oldestLedgerCloseTime: "t",
        cursor: "c",
      }),
    );

    await fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], cursor: "prev-cursor" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.params.pagination).toEqual({ cursor: "prev-cursor" });
    expect(parsedBody.params.startLedger).toBeUndefined();
  });

  it("maps a valid getEvents result to EventsPage/RawEvent", async () => {
    mockFetchOnce(
      jsonRpcResult({
        events: [makeBootnodeEvent()],
        latestLedger: 3900300,
        latestLedgerCloseTime: "2026-07-30T12:05:00Z",
        oldestLedger: 3890000,
        oldestLedgerCloseTime: "2026-07-29T12:00:00Z",
        cursor: "0004100553739857920-0000000004",
      }),
    );

    const page = await fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], startLedger: 3900000 });

    if ("handoff" in page) throw new Error("expected an EventsPage, got a handoff");
    expect(page.latestLedger).toBe(3900300);
    expect(page.oldestLedger).toBe(3890000);
    expect(page.cursor).toBe("0004100553739857920-0000000004");
    expect(page.events).toHaveLength(1);

    const raw = page.events[0]!;
    expect(raw.id).toBe(naturalEventId({ ledger: 3900251, txHash: "a1b2c3d4e5f6", opIndex: 0, eventIndex: 3 }));
    expect(raw.contractId).toBe(CONTRACT_ID);
    expect(raw.ledgerClosedAt).toEqual(new Date("2026-07-30T12:00:00Z"));
    expect(raw.txIndex).toBe(2);
    expect(raw.opIndex).toBe(0);
    expect(raw.eventIndex).toBe(3);
    expect(raw.topic).toEqual(["AAAADwAAAAh0cmFuc2Zlcg=="]);
    expect(raw.valueXdr).toBe("AAAAAA==");
    expect(raw.inSuccessfulCall).toBe(true);
  });

  it("maps -32002 to a {handoff:{fromLedger}} return value (retention handoff)", async () => {
    mockFetchOnce(
      jsonRpcError({
        code: -32002,
        message: "Continue syncing on your RPC endpoint",
        data: { reason: "retention_threshold", fromLedger: 2913600 },
      }),
    );

    const page = await fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], startLedger: 1 });
    expect(page).toEqual({ handoff: { fromLedger: 2913600 } });
  });

  it("throws BootnodeCacheMissError on -32004 (tip unknown / warming-up variant)", async () => {
    mockFetchOnce(jsonRpcError({ code: -32004, message: "bootnode warming up; retry later" }));

    await expect(fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], startLedger: 1 })).rejects.toThrow(
      BootnodeCacheMissError,
    );
  });

  it("throws BootnodeCacheMissError on -32004 (indexer catching-up variant)", async () => {
    mockFetchOnce(
      jsonRpcError({ code: -32004, message: "cache miss; indexer may still be catching up" }),
    );

    await expect(fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], startLedger: 1 })).rejects.toThrow(
      "cache miss; indexer may still be catching up",
    );
  });

  it("throws a plain Error for an unmapped JSON-RPC error code", async () => {
    mockFetchOnce(jsonRpcError({ code: -32602, message: "unsupported filters" }));

    await expect(fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], startLedger: 1 })).rejects.toThrow(
      /unsupported filters/,
    );
  });

  it("throws when neither startLedger nor cursor is given", async () => {
    await expect(fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID] })).rejects.toThrow(
      /startLedger|cursor/,
    );
  });

  it("throws when a mapped event is missing a required field", async () => {
    mockFetchOnce(
      jsonRpcResult({
        events: [makeBootnodeEvent({ txHash: undefined })],
        latestLedger: 100,
        latestLedgerCloseTime: "t",
        oldestLedger: 1,
        oldestLedgerCloseTime: "t",
        cursor: "c",
      }),
    );

    await expect(fetchBootnodeEvents(URL, { contractIds: [CONTRACT_ID], startLedger: 1 })).rejects.toThrow();
  });
});
