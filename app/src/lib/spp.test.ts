/**
 * `spp.ts` unit tests — the pieces that are testable without a browser (no
 * wasm SDK, no OPFS, no network).
 *
 * `connectSppRail` is covered by stubbing `SppRail.connect` (which it calls as
 * a static method, so a `vi.spyOn` intercepts it): the memoization/lifetime
 * rules it enforces are the ones that produced this task's two hardest bugs,
 * and they are pure control flow worth pinning.
 *
 * Note: those cases re-import the module (`freshModule`) to reset its
 * page-scoped memo, so class identity assertions must use the FRESH copy's
 * `SppWalletSwitchError`, not a top-level import's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asExecuteResult,
  SppRail,
  stroopsToKitXlm,
  type SppConnectOptions,
  type SppConnectPhase,
} from "./spp.js";

/** Two distinct, valid secrets ⇒ two distinct session addresses ⇒ two distinct cache keys. */
const SECRET_A = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
const SECRET_B = "SBUMVJHCL5Y46U4W4EI4HOGKATTQDJP6TDPU6SMYOLUV5BTHJ54LG6KU";
const WALLET_A = "CCH2EB4POGCUBF5FJ7HTGKUEJDQ2TWIFEE35JOCAEF6RBEXCBHNXF4HK";
const WALLET_B = "CCUPPFQZ76GMEFGCWL5DRGGFCL3IOBCUBQKL2ATWX5Z6X2EEKJDUPGAI";

/**
 * `connectSppRail` memoizes in module scope, so every test must start from a
 * clean slot. Resetting the module registry gives each test its own copy.
 */
async function freshModule(): Promise<typeof import("./spp.js")> {
  vi.resetModules();
  return import("./spp.js");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stroopsToKitXlm", () => {
  it("converts whole and fractional stroop amounts exactly", () => {
    expect(stroopsToKitXlm(10_0000000n)).toBe(10);
    expect(stroopsToKitXlm(1n)).toBe(0.0000001);
    expect(stroopsToKitXlm(10050_0000000n)).toBe(10050);
  });

  it("round-trips through the kit's own conversion", () => {
    // `kit.transfer` does BigInt(Math.round(xlm * 10_000_000)) internally
    // (smart-account-kit/src/utils.ts:92-94) — the value it recovers must be
    // the exact stroop amount we started from.
    for (const stroops of [1n, 7n, 10_0000000n, 50_0000000n, 10044_4666909n]) {
      expect(BigInt(Math.round(stroopsToKitXlm(stroops) * 10_000_000))).toBe(stroops);
    }
  });

  it("throws rather than silently losing precision on an amount a float cannot carry", () => {
    // Beyond 2^53 stroops the float round-trip stops being exact; the guard
    // must refuse instead of moving a wrong amount.
    expect(() => stroopsToKitXlm(90071992547409911n)).toThrow(/cannot be represented exactly/);
  });
});

describe("asExecuteResult", () => {
  it("narrows a success envelope", () => {
    expect(asExecuteResult({ status: "ok", hashes: ["a", "b"] })).toEqual({
      status: "ok",
      hashes: ["a", "b"],
    });
  });

  it("narrows aspNotReady (which carries no other fields)", () => {
    expect(asExecuteResult({ status: "aspNotReady" })).toEqual({ status: "aspNotReady" });
  });

  it("narrows a failure, keeping already-submitted hashes and the SEP-43 code", () => {
    expect(
      asExecuteResult({ status: "failed", hashes: ["a"], message: "boom", code: -4 })
    ).toEqual({ status: "failed", hashes: ["a"], message: "boom", code: -4 });
  });

  it("defaults a failure's missing fields rather than producing undefined copy", () => {
    expect(asExecuteResult({ status: "failed" })).toEqual({
      status: "failed",
      hashes: [],
      message: "Transaction failed",
    });
  });

  it("treats an unrecognized or nullish envelope as a failure, never as success", () => {
    expect(asExecuteResult(undefined).status).toBe("failed");
    expect(asExecuteResult(null).status).toBe("failed");
    expect(asExecuteResult({ status: "weird" })).toMatchObject({
      status: "failed",
      message: expect.stringContaining("weird"),
    });
  });
});

describe("connectSppRail", () => {
  it("returns the SAME promise for a repeated call (StrictMode double-invoke)", async () => {
    const spp = await freshModule();
    const fake = {} as SppRail;
    const connect = vi.spyOn(spp.SppRail, "connect").mockResolvedValue(fake);

    const first = spp.connectSppRail(SECRET_A, WALLET_A);
    const second = spp.connectSppRail(SECRET_A, WALLET_A);

    expect(second).toBe(first);
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBe(fake);
  });

  it("re-points the phase listener at the latest subscriber and replays the current phase", async () => {
    const spp = await freshModule();
    let emit: ((phase: SppConnectPhase) => void) | undefined;
    vi.spyOn(spp.SppRail, "connect").mockImplementation(
      async (_secret: string, _wallet: string, options?: SppConnectOptions) => {
        emit = options?.onPhase;
        return {} as SppRail;
      }
    );

    const first: SppConnectPhase[] = [];
    const second: SppConnectPhase[] = [];
    spp.connectSppRail(SECRET_A, WALLET_A, { onPhase: (p) => first.push(p) });
    emit?.("syncing-history");

    // The StrictMode remount: a second subscriber takes over and must be told
    // where the connect already got to.
    spp.connectSppRail(SECRET_A, WALLET_A, { onPhase: (p) => second.push(p) });
    emit?.("deriving-keys");

    expect(first).toEqual(["syncing-history"]);
    expect(second).toEqual(["syncing-history", "deriving-keys"]);
  });

  it("does NOT detach the live listener when a later caller passes no onPhase", async () => {
    const spp = await freshModule();
    let emit: ((phase: SppConnectPhase) => void) | undefined;
    vi.spyOn(spp.SppRail, "connect").mockImplementation(
      async (_secret: string, _wallet: string, options?: SppConnectOptions) => {
        emit = options?.onPhase;
        return {} as SppRail;
      }
    );

    const phases: SppConnectPhase[] = [];
    spp.connectSppRail(SECRET_A, WALLET_A, { onPhase: (p) => phases.push(p) });
    spp.connectSppRail(SECRET_A, WALLET_A); // e.g. a non-subscribing caller
    emit?.("opening-pool");

    expect(phases).toEqual(["opening-pool"]);
  });

  it("keys on the session address AND the wallet, so the same secret under a different wallet is a switch", async () => {
    const spp = await freshModule();
    vi.spyOn(spp.SppRail, "connect").mockResolvedValue({} as SppRail);

    await spp.connectSppRail(SECRET_A, WALLET_A);
    await expect(spp.connectSppRail(SECRET_A, WALLET_B)).rejects.toBeInstanceOf(
      spp.SppWalletSwitchError
    );
  });

  it("refuses a different wallet instead of opening a second storage worker", async () => {
    const spp = await freshModule();
    const connect = vi.spyOn(spp.SppRail, "connect").mockResolvedValue({} as SppRail);

    await spp.connectSppRail(SECRET_A, WALLET_A);
    await expect(spp.connectSppRail(SECRET_B, WALLET_B)).rejects.toBeInstanceOf(
      spp.SppWalletSwitchError
    );
    // The load-bearing assertion: no second `SppRail.connect` (hence no second
    // `Storage.open()`) was attempted on the same page.
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed connect, so a later attempt retries", async () => {
    const spp = await freshModule();
    const connect = vi
      .spyOn(spp.SppRail, "connect")
      .mockRejectedValueOnce(new Error("api server down"))
      .mockResolvedValueOnce({} as SppRail);

    await expect(spp.connectSppRail(SECRET_A, WALLET_A)).rejects.toThrow("api server down");
    await expect(spp.connectSppRail(SECRET_A, WALLET_A)).resolves.toBeDefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
