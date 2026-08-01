/**
 * TDD spec for `normalizeCtEvent` (Task 8), against REAL Confidential Token
 * events captured live from testnet.
 *
 * Fixture provenance (`__fixtures__/ct-events.json`): fetched via a one-off
 * `fetchRpcEvents(TESTNET.rpcUrl, { contractIds: [TESTNET.ct.token],
 * startLedger: TESTNET.ct.deployedAtLedger, limit: 200 })` call against the
 * public Soroban testnet RPC (2026-07-31) — the exact same 13 rows Task 7's
 * live worker run landed in the local Postgres `events` table (ledger
 * 3900254–3900654; the local DB's copy had since been wiped by a fresh
 * `docker compose up`, so this re-fetch reproduced the identical page from
 * chain, confirmed by matching ids/ledger-range against the Task 7 report).
 * Every expected value below (addresses, amounts, hex ciphertext fields) was
 * independently decoded from these exact rows with `xdr.ScVal.fromXDR` +
 * `scValToNative`/`.bytes()` in a throwaway script and hand-copied here — see
 * task-8-report.md for the full decode transcript.
 *
 * IMPORTANT field-name finding: the deployed contract's on-chain event field
 * names (`r_e`, `sigma`, `b_tilde`, `b_aud_s`, `v_tilde`, `v_aud_r`,
 * `r_aud_r`, `v_aud_s`) match the vendored `@ctd/sdk`'s
 * `packages/ctd-sdk/src/chain/events.ts` field mapping EXACTLY — NOT the
 * checked-out `resources/stellar-contracts` branch's current Rust source
 * (`packages/tokens/src/confidential/mod.rs`), which has since renamed
 * several of these fields (e.g. `b_aud_s` -> `b_tilde_aud_s`, `v_aud_r` ->
 * `v_tilde_aud_r`). The deployed testnet contract predates that rename.
 * Fixtures are ground truth; `normalize-ct.ts` follows the FIXTURE names.
 */
import { describe, expect, it } from "vitest";
import rawFixtures from "./__fixtures__/ct-events.json" with { type: "json" };
import type { RawEvent } from "../../lib/soroban-events.js";
import { normalizeCtEvent } from "./normalize-ct.js";

const TOKEN_ID = "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH";

/** `RawEvent[]`, restoring `ledgerClosedAt` from its JSON-serialized ISO string back to a `Date`. */
function loadFixtures(): RawEvent[] {
  return (rawFixtures as Array<Omit<RawEvent, "ledgerClosedAt"> & { ledgerClosedAt: string }>).map((e) => ({
    ...e,
    ledgerClosedAt: new Date(e.ledgerClosedAt),
  }));
}

const fixtures = loadFixtures();

function fixtureAt(index: number): RawEvent {
  const event = fixtures[index];
  if (event === undefined) throw new Error(`fixture ${index} missing`);
  return event;
}

describe("normalizeCtEvent — non-CT-activity topics return null", () => {
  it.each([
    [0, "underlying_asset_set"],
    [1, "verifier_set"],
    [2, "auditor_set"],
    [3, "address_as_field_set"],
  ])("fixture %i (%s) -> null", (index) => {
    expect(normalizeCtEvent(fixtureAt(index), TOKEN_ID)).toBeNull();
  });

  it("returns null when the event's contractId does not match tokenId", () => {
    // fixture 6 is a real `register` event — would normally map to a row.
    expect(normalizeCtEvent(fixtureAt(6), "COTHERCONTRACTIDNOTMATCHINGTOKEN")).toBeNull();
  });

  it("returns null for an event with zero topics", () => {
    const event: RawEvent = { ...fixtureAt(6), topic: [] };
    expect(normalizeCtEvent(event, TOKEN_ID)).toBeNull();
  });

  it("returns null for a CT-emitted-but-unmapped event type (e.g. spender_transfer)", () => {
    // A real symbol emitted by the same contract (`SpenderTransfer`, see
    // `resources/stellar-contracts/packages/tokens/src/confidential/mod.rs:741`),
    // not in our register/deposit/merge/withdraw/transfer whitelist. XDR
    // generated with `xdr.ScVal.scvSymbol("spender_transfer").toXDR("base64")`
    // and round-trip-verified to decode back to `"spender_transfer"` before
    // being pasted in here (not hand-encoded).
    const event: RawEvent = {
      ...fixtureAt(6),
      topic: ["AAAADwAAABBzcGVuZGVyX3RyYW5zZmVy", fixtureAt(6).topic[1]!],
    };
    expect(normalizeCtEvent(event, TOKEN_ID)).toBeNull();
  });
});

describe("normalizeCtEvent — register", () => {
  it("maps to a single self-row with no amount and empty ciphertexts", () => {
    const rows = normalizeCtEvent(fixtureAt(4), TOKEN_ID);
    expect(rows).toEqual([
      {
        account: "CB3I3Y5QD45DT4WHIRLTPLSEQSWKFFTGYYX5DDSDBXJALA4CP7CDB2WM",
        type: "register",
        counterparty: "CB3I3Y5QD45DT4WHIRLTPLSEQSWKFFTGYYX5DDSDBXJALA4CP7CDB2WM",
        amount: null,
        ledger: 3900607,
        txHash: "e512b3263d080dd42397172d9cd4a5196d6427c6cc686388b60655adc8c1b5ed",
        eventId: fixtureAt(4).id,
        ciphertexts: {},
      },
    ]);
  });

  it("decodes a second real register event with a G-address account", () => {
    const rows = normalizeCtEvent(fixtureAt(5), TOKEN_ID);
    expect(rows).toEqual([
      {
        account: "GDKDHCBUK66GREB4NO2NHM4SJ2LR27X3UWY3FNPX72PCHOB277XK23UD",
        type: "register",
        counterparty: "GDKDHCBUK66GREB4NO2NHM4SJ2LR27X3UWY3FNPX72PCHOB277XK23UD",
        amount: null,
        ledger: 3900609,
        txHash: "608108748298ca98824fff103a5f61722d9d5d0dfabe399561b039e604533fd3",
        eventId: fixtureAt(5).id,
        ciphertexts: {},
      },
    ]);
  });
});

describe("normalizeCtEvent — deposit", () => {
  it("maps a self-deposit (from === to) to a single row with the public amount", () => {
    const rows = normalizeCtEvent(fixtureAt(8), TOKEN_ID);
    expect(rows).toEqual([
      {
        account: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        type: "deposit",
        counterparty: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        amount: "1000000000",
        ledger: 3900642,
        txHash: "2af0fc9b44a3cfd95d18ec6d7b4ce0d472385755f79d80a6692ec3b86db32d7e",
        eventId: fixtureAt(8).id,
        ciphertexts: {},
      },
    ]);
  });

  it("maps a cross-account deposit to two rows (one per side), sharing the same public amount", () => {
    const event: RawEvent = {
      ...fixtureAt(8),
      topic: [
        fixtureAt(8).topic[0]!,
        fixtureAt(8).topic[1]!,
        // GDKDHCBUK66GREB4NO2NHM4SJ2LR27X3UWY3FNPX72PCHOB277XK23UD (fixture 5's
        // register account) — generated with `new Address(...).toScVal().toXDR("base64")`
        // and round-trip-verified to decode back to that exact strkey.
        "AAAAEgAAAAAAAAAA1DOINFe8aJA8a7TTs5JOlx1++6WxsrX3/p4juDr/7q0=",
      ],
    };
    const rows = normalizeCtEvent(event, TOKEN_ID);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
          counterparty: "GDKDHCBUK66GREB4NO2NHM4SJ2LR27X3UWY3FNPX72PCHOB277XK23UD",
          type: "deposit",
          amount: "1000000000",
        }),
        expect.objectContaining({
          account: "GDKDHCBUK66GREB4NO2NHM4SJ2LR27X3UWY3FNPX72PCHOB277XK23UD",
          counterparty: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
          type: "deposit",
          amount: "1000000000",
        }),
      ]),
    );
  });
});

describe("normalizeCtEvent — merge", () => {
  it("maps to a single self-row with no amount and empty ciphertexts", () => {
    const rows = normalizeCtEvent(fixtureAt(9), TOKEN_ID);
    expect(rows).toEqual([
      {
        account: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        type: "merge",
        counterparty: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        amount: null,
        ledger: 3900644,
        txHash: "d96246f5f752c23c32241049d3a7c27fc39dcb74e7df0840fce28ae42a0ff2a1",
        eventId: fixtureAt(9).id,
        ciphertexts: {},
      },
    ]);
  });
});

describe("normalizeCtEvent — transfer", () => {
  it("maps to two rows (from + to), amount null, full ciphertext set hex-encoded", () => {
    const rows = normalizeCtEvent(fixtureAt(10), TOKEN_ID);
    const ciphertexts = {
      rE: "0x176947b28fe198b1adfebff7122ebeac475eef7f5458fbdb8b2d00ce282dfbe126170544742b1e49d25ea497af4fd8007c9c65f7a751192223b0bcead2d1ae6c",
      vTilde: "0x22495f4e7d4bdd1cdedf941ebe5cfb041598d7519119f237c1c3d38749a658d2",
      sigma: "0x00bc8be5cde151ec408331ec685e821c6b4f42496067c5d8151f8be1f54d54c3",
      bTilde: "0x142426bd5f5dd5c0ff3c6ecc46be9a81241448b27939ac9c3c1e3956750aac17",
      vAudR: "0x2c69601b63479ade2bfd319d58971fb54b28cdb1928e0b12ef09ba0c26f9375d",
      rAudR: "0x02674cdf407f13a26190304608f6d8b73a0e9181e825e4970d669ea1f2f9908d",
      vAudS: "0x2e1bae274a248e25f2c5f6d26f7200c4400a3c2154d027e1367ea8b72a409131",
      bAudS: "0x10781d982c6489c7d7a0386216b56af6f40eb20fb2b2cd4fc652f60b5e8b08e3",
    };
    expect(rows).toEqual([
      {
        account: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        type: "transfer",
        counterparty: "GBRAOYRIYBS55SZNDA4PY5L3ZRIWMM5KQ5RWBNNMYI4UBCVZJFBS56OP",
        amount: null,
        ledger: 3900648,
        txHash: "83f685f5b597fa1bb2f6648a2017d7e81625097fb0f3a81d9654992850079a85",
        eventId: fixtureAt(10).id,
        ciphertexts,
      },
      {
        account: "GBRAOYRIYBS55SZNDA4PY5L3ZRIWMM5KQ5RWBNNMYI4UBCVZJFBS56OP",
        type: "transfer",
        counterparty: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        amount: null,
        ledger: 3900648,
        txHash: "83f685f5b597fa1bb2f6648a2017d7e81625097fb0f3a81d9654992850079a85",
        eventId: fixtureAt(10).id,
        ciphertexts,
      },
    ]);
  });
});

describe("normalizeCtEvent — withdraw", () => {
  it("maps to a single row for `from`, public amount, checkpoint ciphertext fields hex-encoded", () => {
    const rows = normalizeCtEvent(fixtureAt(11), TOKEN_ID);
    expect(rows).toEqual([
      {
        account: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        type: "withdraw",
        counterparty: "CBL2LDYSE42ZJKSPSGTWXCR4DWET7AFENAPDICYEYRQB54WWN4SSK7II",
        amount: "600000000",
        ledger: 3900652,
        txHash: "03fff0ec505ceba287c314f9ffe0e9d9f55c8699aeb58c24d74a4508ff8e5c02",
        eventId: fixtureAt(11).id,
        ciphertexts: {
          rE: "0x2289328cf0e844ba3b74aca42a1df3c54dfd51851c984a424ae109ad9ac4047913fcda2981c3ae866454f5debc39d25dcd572d8f32475c710bb07ac8e3c92e29",
          sigma: "0x00f3807465597d19b75ff02716501341cf2c97a411d1b5f23737f29b8a2eb1e8",
          bTilde: "0x2c956f34fe4c55217c9a25ceb1453c2a9a7c767217f2039c6af91e01f7cd9d6d",
          bAudS: "0x19b830d463690719f115789c7b3a9c24d5652c1442b6c5fb8b32b8cd3bd3e4b5",
        },
      },
    ]);
  });
});

describe("normalizeCtEvent — is a pure function", () => {
  it("does not mutate the input RawEvent", () => {
    const event = fixtureAt(10);
    const before: RawEvent = { ...event, topic: [...event.topic], ledgerClosedAt: new Date(event.ledgerClosedAt) };
    normalizeCtEvent(event, TOKEN_ID);
    expect(event).toEqual(before);
  });

  it("is deterministic: same input twice produces deep-equal output", () => {
    const a = normalizeCtEvent(fixtureAt(10), TOKEN_ID);
    const b = normalizeCtEvent(fixtureAt(10), TOKEN_ID);
    expect(a).toEqual(b);
  });
});
