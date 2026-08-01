import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUpstreamLatestLedger } from "./rpc-proxy.js";

const RPC_URL = "https://soroban-testnet.stellar.org";

function mockFetchOnce(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Same hung-connection shape as `bootnode-client.test.ts`'s — only settles (AbortError) once the caller's signal aborts. */
function mockHangingFetch() {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUpstreamLatestLedger", () => {
  it("POSTs a raw JSON-RPC 2.0 getLatestLedger request", async () => {
    const fetchMock = mockFetchOnce({
      jsonrpc: "2.0",
      id: 1,
      result: { id: "abc", protocolVersion: 27, sequence: 3914875, closeTime: "1785593897" },
    });

    await fetchUpstreamLatestLedger(RPC_URL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(RPC_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestLedger",
      params: {},
    });
  });

  it("returns only {id, protocolVersion, sequence, closeTime} — extra RPC fields (headerXdr/metadataXdr) are dropped", async () => {
    mockFetchOnce({
      jsonrpc: "2.0",
      id: 1,
      result: {
        id: "abc",
        protocolVersion: 27,
        sequence: 3914875,
        closeTime: "1785593897",
        headerXdr: "AAAA",
        metadataXdr: "BBBB",
      },
    });

    const result = await fetchUpstreamLatestLedger(RPC_URL);
    expect(result).toEqual({ id: "abc", protocolVersion: 27, sequence: 3914875, closeTime: "1785593897" });
  });

  it("throws on a JSON-RPC error response", async () => {
    mockFetchOnce({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } });

    await expect(fetchUpstreamLatestLedger(RPC_URL)).rejects.toThrow(/internal error/);
  });

  it("throws on a non-OK HTTP response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUpstreamLatestLedger(RPC_URL)).rejects.toThrow(/503/);
  });

  it("throws when the result is missing a required numeric field (wrong type is not silently coerced)", async () => {
    mockFetchOnce({ jsonrpc: "2.0", id: 1, result: { id: "abc", protocolVersion: "27", sequence: 3914875 } });

    await expect(fetchUpstreamLatestLedger(RPC_URL)).rejects.toThrow();
  });

  it("times out a hung request and surfaces it as a normal rejected Error", async () => {
    const fetchMock = mockHangingFetch();

    await expect(fetchUpstreamLatestLedger(RPC_URL, { timeoutMs: 20 })).rejects.toThrow(/timed out after 20ms/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
