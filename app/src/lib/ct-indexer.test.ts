/**
 * Unit tests for the XDR-decoding indexer adapter (`ct-indexer.ts`).
 *
 * All four event rows below are REAL, not synthetic: captured live from
 * `@privacy-wallet/api`'s actual `GET /contracts/:contractId/events` HTTP
 * response, running against a local Postgres seeded from the committed,
 * live-captured fixture `api/src/modules/indexer/__fixtures__/ct-events.json`
 * (13 real events from the deployed testnet CT contract, gate #1's run —
 * see `docs/modules/api.md`'s and `docs/modules/ct-tx.md`'s module docs for
 * provenance). Capture transcript (2026-08-01):
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://grantfox:grantfox@localhost:5433/grantfox \
 *     pnpm --filter @privacy-wallet/api exec drizzle-kit migrate
 *   # seeded events + normalized ct_activity from the committed fixture
 *   DATABASE_URL=postgres://grantfox:grantfox@localhost:5433/grantfox PORT=3801 \
 *     pnpm --filter @privacy-wallet/api exec tsx src/server.ts &
 *   curl "http://localhost:3801/contracts/CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH/events?startLedger=0&limit=20"
 *
 * The transfer row's decoded field values are cross-checked against
 * `GET /accounts/:address/activity`'s independently-decoded hex
 * `ciphertexts` for the SAME on-chain event (`normalize-ct.ts`'s decoder,
 * hex-encoding raw bytes with no curve-point math) — two different decode
 * paths reading the same base64-XDR bytes, asserted to agree bit-for-bit.
 */
import { describe, expect, it, vi } from "vitest";
import { pointFromBytes, hexToBytes, type ConfidentialEvent, type TransferEvent } from "@ctd/sdk";
import { ApiIndexerClient, parseApiEvent } from "./ct-indexer.js";

const TOKEN = "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH";
const C_ADDRESS = "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II";
const BOB_ADDRESS = "GBRAOYRIYBS55SZNDA4PY5L3ZRIWMM5KQ5RWBNNMYI4UBCVZJFBS56OP";

/** Real row: a constructor-setter event (`underlying_asset_set`) — not a CT-activity event, must decode to `null`. */
const UNMAPPED_ROW = {
  id: "3900254-cbc966b7b4ca50981536e5afa24fb9b2f76eabf483a7980113b2f5e2b9fe6d1a-0-0",
  ledger: 3900254,
  txHash: "cbc966b7b4ca50981536e5afa24fb9b2f76eabf483a7980113b2f5e2b9fe6d1a",
  topic: ["AAAADwAAABR1bmRlcmx5aW5nX2Fzc2V0X3NldA=="],
  value:
    "AAAAEQAAAAEAAAABAAAADwAAABB1bmRlcmx5aW5nX2Fzc2V0AAAAEgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQ==",
};

/** Real row: `C` registers with `auditor_id = 0` (gate #1's run). */
const REGISTER_ROW = {
  id: "3900638-38d98eb08338890b3c5724f4663bb2a436451b68fbb309c7e042cece4cca6731-0-0",
  ledger: 3900638,
  txHash: "38d98eb08338890b3c5724f4663bb2a436451b68fbb309c7e042cece4cca6731",
  topic: ["AAAADwAAAAhyZWdpc3Rlcg==", "AAAAEgAAAAFXpY8SJzWUqk+Rp2uKPB2JP4CkaB40CwTEYB7y1m8lJQ=="],
  value: "AAAAEQAAAAEAAAABAAAADwAAAAphdWRpdG9yX2lkAAAAAAADAAAAAA==",
};

/** Real row: `C` self-deposits 1_000_000_000 stroops. */
const DEPOSIT_ROW = {
  id: "3900642-2af0fc9b44a3cfd95d18ec6d7b4ce0d472385755f79d80a6692ec3b86db32d7e-0-1",
  ledger: 3900642,
  txHash: "2af0fc9b44a3cfd95d18ec6d7b4ce0d472385755f79d80a6692ec3b86db32d7e",
  topic: [
    "AAAADwAAAAdkZXBvc2l0AA==",
    "AAAAEgAAAAFXpY8SJzWUqk+Rp2uKPB2JP4CkaB40CwTEYB7y1m8lJQ==",
    "AAAAEgAAAAFXpY8SJzWUqk+Rp2uKPB2JP4CkaB40CwTEYB7y1m8lJQ==",
  ],
  value: "AAAAEQAAAAEAAAABAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAA7msoA",
};

/** Real row: `C -> bob`, 40 XLM confidential transfer (gate #1's run). */
const TRANSFER_ROW = {
  id: "3900648-83f685f5b597fa1bb2f6648a2017d7e81625097fb0f3a81d9654992850079a85-0-0",
  ledger: 3900648,
  txHash: "83f685f5b597fa1bb2f6648a2017d7e81625097fb0f3a81d9654992850079a85",
  topic: [
    "AAAADwAAAAh0cmFuc2Zlcg==",
    "AAAAEgAAAAFXpY8SJzWUqk+Rp2uKPB2JP4CkaB40CwTEYB7y1m8lJQ==",
    "AAAAEgAAAAAAAAAAYgdiKMBl3sstGDj8dXvMUWYzqodjYLWswjlAirlJQy4=",
  ],
  value:
    "AAAAEQAAAAEAAAAIAAAADwAAAAdiX2F1ZF9zAAAAAA0AAAAgEHgdmCxkicfXoDhiFrVq9vQOsg+yss1PxlL2C16LCOMAAAAPAAAAB2JfdGlsZGUAAAAADQAAACAUJCa9X13VwP88bsxGvpqBJBRIsnk5rJw8HjlWdQqsFwAAAA8AAAAHcl9hdWRfcgAAAAANAAAAIAJnTN9AfxOiYZAwRgj22Lc6DpGB6CXklw1mnqHy+ZCNAAAADwAAAANyX2UAAAAADQAAAEAXaUeyj+GYsa3+v/cSLr6sR17vf1RY+9uLLQDOKC374SYXBUR0Kx5J0l6kl69P2AB8nGX3p1EZIiOwvOrS0a5sAAAADwAAAAVzaWdtYQAAAAAAAA0AAAAgALyL5c3hUexAgzHsaF6CHGtPQklgZ8XYFR+L4fVNVMMAAAAPAAAAB3ZfYXVkX3IAAAAADQAAACAsaWAbY0ea3iv9MZ1Ylx+1SyjNsZKOCxLvCboMJvk3XQAAAA8AAAAHdl9hdWRfcwAAAAANAAAAIC4bridKJI4l8sX20m9yAMRACjwhVNAn4TZ+qLcqQJExAAAADwAAAAd2X3RpbGRlAAAAAA0AAAAgIklfTn1L3Rze35Qevlz7BBWY11GRGfI3wcPTh0mmWNI=",
};

/** The SAME transfer event's ciphertexts, independently captured from `GET /accounts/:address/activity` (`normalize-ct.ts`'s hex-encoding decoder — no curve-point math). */
const TRANSFER_CIPHERTEXTS_FROM_ACTIVITY_FEED = {
  rE: "0x176947b28fe198b1adfebff7122ebeac475eef7f5458fbdb8b2d00ce282dfbe126170544742b1e49d25ea497af4fd8007c9c65f7a751192223b0bcead2d1ae6c",
  bAudS: "0x10781d982c6489c7d7a0386216b56af6f40eb20fb2b2cd4fc652f60b5e8b08e3",
  rAudR: "0x02674cdf407f13a26190304608f6d8b73a0e9181e825e4970d669ea1f2f9908d",
  sigma: "0x00bc8be5cde151ec408331ec685e821c6b4f42496067c5d8151f8be1f54d54c3",
  vAudR: "0x2c69601b63479ade2bfd319d58971fb54b28cdb1928e0b12ef09ba0c26f9375d",
  vAudS: "0x2e1bae274a248e25f2c5f6d26f7200c4400a3c2154d027e1367ea8b72a409131",
  bTilde: "0x142426bd5f5dd5c0ff3c6ecc46be9a81241448b27939ac9c3c1e3956750aac17",
  vTilde: "0x22495f4e7d4bdd1cdedf941ebe5cfb041598d7519119f237c1c3d38749a658d2",
};

describe("parseApiEvent", () => {
  it("returns null for a non-CT-activity (constructor-setter) event", () => {
    expect(parseApiEvent(UNMAPPED_ROW)).toBeNull();
  });

  it("returns null for an event with no topics", () => {
    expect(parseApiEvent({ ...UNMAPPED_ROW, topic: [] })).toBeNull();
  });

  it("decodes a real register event", () => {
    const ev = parseApiEvent(REGISTER_ROW);
    expect(ev).toEqual({
      type: "register",
      ledger: 3900638,
      txHash: REGISTER_ROW.txHash,
      cursor: REGISTER_ROW.id,
      account: C_ADDRESS,
      auditorId: 0,
    });
  });

  it("decodes a real deposit event (self-deposit, from === to)", () => {
    const ev = parseApiEvent(DEPOSIT_ROW);
    expect(ev).toEqual({
      type: "deposit",
      ledger: 3900642,
      txHash: DEPOSIT_ROW.txHash,
      cursor: DEPOSIT_ROW.id,
      from: C_ADDRESS,
      to: C_ADDRESS,
      amount: 1_000_000_000n,
    });
  });

  it("decodes a real transfer event, matching the activity feed's independently-decoded ciphertexts byte-for-byte", () => {
    const ev = parseApiEvent(TRANSFER_ROW) as TransferEvent;
    expect(ev.type).toBe("transfer");
    expect(ev.from).toBe(C_ADDRESS);
    expect(ev.to).toBe(BOB_ADDRESS);
    expect(ev.cursor).toBe(TRANSFER_ROW.id);

    const c = TRANSFER_CIPHERTEXTS_FROM_ACTIVITY_FEED;
    // Field elements: the adapter's `fromBytesBE`-decoded bigint must equal
    // the raw hex bytes the activity feed independently captured.
    expect(ev.sigma).toBe(BigInt(c.sigma));
    expect(ev.vTilde).toBe(BigInt(c.vTilde));
    expect(ev.bTilde).toBe(BigInt(c.bTilde));
    expect(ev.vAudR).toBe(BigInt(c.vAudR));
    expect(ev.rAudR).toBe(BigInt(c.rAudR));
    expect(ev.vAudS).toBe(BigInt(c.vAudS));
    expect(ev.bAudS).toBe(BigInt(c.bAudS));
    // Point: the adapter's `pointFromBytes`-decoded R_e must equal the same
    // 64 raw bytes, decoded independently.
    expect(ev.rE.equals(pointFromBytes(hexToBytes(c.rE)))).toBe(true);
  });
});

function mockFetchOnce(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response),
  );
}

describe("ApiIndexerClient", () => {
  it("fetchEvents decodes a real single-page response and stops when cursor is null", async () => {
    mockFetchOnce({
      latestLedger: 3900654,
      cursor: null,
      events: [REGISTER_ROW, TRANSFER_ROW],
    });
    const client = new ApiIndexerClient({ baseUrl: "http://localhost:3801" });
    const result = await client.fetchEvents({ contractId: TOKEN, startLedger: 3900251 });

    expect(result.latestLedger).toBe(3900654);
    expect(result.cursor).toBeUndefined();
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.type)).toEqual(["register", "transfer"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const calledUrl = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0];
    expect(calledUrl).toContain(`contracts/${TOKEN}/events`);
    expect(calledUrl).toContain("startLedger=3900251");
  });

  it("fetchEvents follows a cursor across two pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ latestLedger: 3900654, cursor: "abc", events: [REGISTER_ROW] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ latestLedger: 3900654, cursor: null, events: [TRANSFER_ROW] }),
        } as Response),
    );
    const client = new ApiIndexerClient({ baseUrl: "http://localhost:3801" });
    const result = await client.fetchEvents({ contractId: TOKEN, startLedger: 3900251 });

    expect(result.events.map((e: ConfidentialEvent) => e.type)).toEqual(["register", "transfer"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondUrl = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls[1]![0];
    expect(secondUrl).toContain("cursor=abc");
  });

  it("fetchEvents throws on a non-OK response (does not silently return an empty stream)", async () => {
    mockFetchOnce({ error: "boom" }, false);
    const client = new ApiIndexerClient({ baseUrl: "http://localhost:3801" });
    await expect(client.fetchEvents({ contractId: TOKEN, startLedger: 0 })).rejects.toThrow(/events 500/);
  });

  it("resolveEventRef finds the matching event by id + txHash", async () => {
    mockFetchOnce({ latestLedger: 3900654, cursor: null, events: [TRANSFER_ROW] });
    const client = new ApiIndexerClient({ baseUrl: "http://localhost:3801" });
    const ev = await client.resolveEventRef(TOKEN, {
      ledger: 3900648,
      id: TRANSFER_ROW.id,
      txHash: TRANSFER_ROW.txHash,
    });
    expect(ev?.type).toBe("transfer");
  });

  it("resolveEventRef returns null when the txHash doesn't match (stale/foreign ref)", async () => {
    mockFetchOnce({ latestLedger: 3900654, cursor: null, events: [TRANSFER_ROW] });
    const client = new ApiIndexerClient({ baseUrl: "http://localhost:3801" });
    const ev = await client.resolveEventRef(TOKEN, {
      ledger: 3900648,
      id: TRANSFER_ROW.id,
      txHash: "0000000000000000000000000000000000000000000000000000000000000",
    });
    expect(ev).toBeNull();
  });
});
