import { Contract, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventIndexFromId, fetchRpcEvents, naturalEventId } from "./soroban-events.js";

const CONTRACT_ID = "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH";

/** A realistic `rpc.Api.EventResponse` (installed sdk-16 shape, see module doc). */
function makeSdkEvent(overrides: Partial<rpc.Api.EventResponse> = {}): rpc.Api.EventResponse {
  return {
    id: "0004100553739857920-0000000003",
    type: "contract",
    ledger: 3900251,
    ledgerClosedAt: "2026-07-30T12:00:00Z",
    transactionIndex: 2,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: "a1b2c3d4e5f6",
    contractId: new Contract(CONTRACT_ID),
    topic: [xdr.ScVal.scvSymbol("transfer")],
    value: xdr.ScVal.scvSymbol("transfer"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRpcEvents", () => {
  it("maps a valid getEvents page to EventsPage/RawEvent", async () => {
    const event = makeSdkEvent();
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({
      events: [event],
      latestLedger: 3900300,
      oldestLedger: 3890000,
      latestLedgerCloseTime: "2026-07-30T12:05:00Z",
      oldestLedgerCloseTime: "2026-07-29T12:00:00Z",
      cursor: "0004100553739857920-0000000004",
    });

    const page = await fetchRpcEvents("https://rpc.example/soroban/rpc", {
      contractIds: [CONTRACT_ID],
      startLedger: 3900000,
      limit: 100,
    });

    expect(page.latestLedger).toBe(3900300);
    expect(page.oldestLedger).toBe(3890000);
    expect(page.cursor).toBe("0004100553739857920-0000000004");
    expect(page.events).toHaveLength(1);

    const raw = page.events[0]!;
    expect(raw.id).toBe(naturalEventId({ ledger: 3900251, txHash: "a1b2c3d4e5f6", opIndex: 0, eventIndex: 3 }));
    expect(raw.contractId).toBe(CONTRACT_ID);
    expect(raw.ledger).toBe(3900251);
    expect(raw.ledgerClosedAt).toEqual(new Date("2026-07-30T12:00:00Z"));
    expect(raw.txHash).toBe("a1b2c3d4e5f6");
    expect(raw.txIndex).toBe(2);
    expect(raw.opIndex).toBe(0);
    expect(raw.eventIndex).toBe(3);
    expect(raw.topic).toEqual([xdr.ScVal.scvSymbol("transfer").toXDR("base64")]);
    expect(raw.valueXdr).toBe(xdr.ScVal.scvSymbol("transfer").toXDR("base64"));
    expect(raw.inSuccessfulCall).toBe(true);
  });

  it("maps response.cursor === '' to a null EventsPage cursor", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({
      events: [],
      latestLedger: 100,
      oldestLedger: 1,
      latestLedgerCloseTime: "t",
      oldestLedgerCloseTime: "t",
      cursor: "",
    });

    const page = await fetchRpcEvents("https://rpc.example/soroban/rpc", {
      contractIds: [CONTRACT_ID],
      startLedger: 1,
      limit: 10,
    });

    expect(page.cursor).toBeNull();
  });

  it("sends a cursor-mode request (no startLedger) when cursor is given", async () => {
    const spy = vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({
      events: [],
      latestLedger: 100,
      oldestLedger: 1,
      latestLedgerCloseTime: "t",
      oldestLedgerCloseTime: "t",
      cursor: "next-cursor",
    });

    await fetchRpcEvents("https://rpc.example/soroban/rpc", {
      contractIds: [CONTRACT_ID],
      cursor: "prev-cursor",
      limit: 10,
    });

    expect(spy).toHaveBeenCalledWith({
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      cursor: "prev-cursor",
      limit: 10,
    });
  });

  it("throws when neither startLedger nor cursor is given", async () => {
    await expect(
      fetchRpcEvents("https://rpc.example/soroban/rpc", { contractIds: [CONTRACT_ID], limit: 10 }),
    ).rejects.toThrow(/startLedger|cursor/);
  });

  it("throws when an event has no resolvable contractId", async () => {
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({
      events: [makeSdkEvent({ contractId: undefined })],
      latestLedger: 100,
      oldestLedger: 1,
      latestLedgerCloseTime: "t",
      oldestLedgerCloseTime: "t",
      cursor: "c",
    });

    await expect(
      fetchRpcEvents("https://rpc.example/soroban/rpc", {
        contractIds: [CONTRACT_ID],
        startLedger: 1,
        limit: 10,
      }),
    ).rejects.toThrow(/contractId/);
  });
});

describe("eventIndexFromId", () => {
  it("reads the eventOrder segment out of an RPC event id", () => {
    expect(eventIndexFromId("0004100553739857920-0000000003")).toBe(3);
  });

  it("throws on an id with no parseable numeric segment", () => {
    expect(() => eventIndexFromId("not-a-valid-id")).toThrow();
  });
});

describe("naturalEventId", () => {
  it("matches @ctd/sdk's format: ${ledger}-${txHash}-${opIndex}-${eventIndex}", () => {
    expect(naturalEventId({ ledger: 3900251, txHash: "a1b2c3d4e5f6", opIndex: 0, eventIndex: 3 })).toBe(
      "3900251-a1b2c3d4e5f6-0-3",
    );
  });
});
