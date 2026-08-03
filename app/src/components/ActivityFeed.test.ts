/**
 * Unit tests for `resolveTransferAmount` — the pure async helper extracted
 * from `ActivityRow`'s decrypt effect (review fix: the effect had no
 * try/catch, so a rejection here left a row stuck on "Decrypting…" forever
 * with no error surfaced). These tests exercise the extracted function
 * directly with a fake `TransferDecryptRail`, not a rendered component —
 * `resolveTransferAmount` is deliberately NOT defensive (mirrors
 * `ct-indexer.ts`'s decoders): it propagates rejections, and it is
 * `ActivityRow`'s job (covered by the live browser e2e in the task report,
 * not a component-render harness here) to catch them and show the
 * retry-affordance error state instead of hanging.
 */
import { describe, expect, it } from "vitest";
import type { ConfidentialEvent, TransferEvent } from "@ctd/sdk";
import { resolveTransferAmount, type ActivityApiRow, type TransferDecryptRail } from "./ActivityFeed.js";

const ME = "CAJCF4JC2DE52MLZB7O7AV6WXNMMVEEP7S4IH2FRPCOEPY3M7K5IQH4G";
const OTHER = "CDZQWNCUJE2CDYCFPWOTXGGFN47ZSVCOVLGXQYHXZ5VLIFNBMA6MVFTY";

const ROW: ActivityApiRow = {
  id: "row-1",
  account: ME,
  type: "transfer",
  counterparty: OTHER,
  amount: null,
  ledger: 3916467,
  txHash: "55dc62d5568c047246ee30fbf27e7c989a21fb16411c43e29d5afaa9b9e56bfb",
  eventId: "3916467-55dc62d5568c047246ee30fbf27e7c989a21fb16411c43e29d5afaa9b9e56bfb-0-0",
  ciphertexts: {},
};

function transferEvent(overrides: Partial<TransferEvent>): TransferEvent {
  return {
    type: "transfer",
    ledger: ROW.ledger,
    txHash: ROW.txHash,
    cursor: ROW.eventId,
    from: ME,
    to: OTHER,
    rE: {} as TransferEvent["rE"],
    vTilde: 0n,
    sigma: 0n,
    bTilde: 0n,
    vAudR: 0n,
    rAudR: 0n,
    vAudS: 0n,
    bAudS: 0n,
    ...overrides,
  };
}

function fakeRail(overrides: Partial<TransferDecryptRail>): TransferDecryptRail {
  return {
    address: ME,
    resolveActivityEvent: async () => null,
    decryptTransferAmount: async () => null,
    ...overrides,
  };
}

describe("resolveTransferAmount", () => {
  it("resolves an inbound transfer (to === me) with a positive direction", async () => {
    const event = transferEvent({ from: OTHER, to: ME });
    const rail = fakeRail({
      resolveActivityEvent: async () => event,
      decryptTransferAmount: async () => 40_0000000n,
    });
    await expect(resolveTransferAmount(ROW, rail)).resolves.toEqual({ amount: 40_0000000n, direction: "in" });
  });

  it("resolves an outbound transfer (from === me) with a negative direction", async () => {
    const event = transferEvent({ from: ME, to: OTHER });
    const rail = fakeRail({
      resolveActivityEvent: async () => event,
      decryptTransferAmount: async () => 40_0000000n,
    });
    await expect(resolveTransferAmount(ROW, rail)).resolves.toEqual({ amount: 40_0000000n, direction: "out" });
  });

  it("resolves null when the on-chain event can't be matched (not an error)", async () => {
    const rail = fakeRail({ resolveActivityEvent: async () => null });
    await expect(resolveTransferAmount(ROW, rail)).resolves.toBeNull();
  });

  it("resolves null when the matched event isn't a transfer", async () => {
    const registerEvent: ConfidentialEvent = {
      type: "register",
      ledger: ROW.ledger,
      txHash: ROW.txHash,
      cursor: ROW.eventId,
      account: ME,
      auditorId: 0,
    };
    const rail = fakeRail({ resolveActivityEvent: async () => registerEvent });
    await expect(resolveTransferAmount(ROW, rail)).resolves.toBeNull();
  });

  it("resolves direction with an undefined amount when the amount can't be decrypted (still confidential)", async () => {
    const event = transferEvent({ from: ME, to: OTHER });
    const rail = fakeRail({
      resolveActivityEvent: async () => event,
      decryptTransferAmount: async () => null,
    });
    await expect(resolveTransferAmount(ROW, rail)).resolves.toEqual({ amount: undefined, direction: "out" });
  });

  it("propagates a rejection from resolveActivityEvent (network failure) instead of swallowing it", async () => {
    const rail = fakeRail({
      resolveActivityEvent: async () => {
        throw new Error("network error");
      },
    });
    await expect(resolveTransferAmount(ROW, rail)).rejects.toThrow("network error");
  });

  it("propagates a rejection from decryptTransferAmount (e.g. confidentialBalance simulate failure) instead of swallowing it", async () => {
    const event = transferEvent({ from: ME, to: OTHER });
    const rail = fakeRail({
      resolveActivityEvent: async () => event,
      decryptTransferAmount: async () => {
        throw new Error("simulate failed");
      },
    });
    await expect(resolveTransferAmount(ROW, rail)).rejects.toThrow("simulate failed");
  });
});
