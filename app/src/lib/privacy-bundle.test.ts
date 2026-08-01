/**
 * TDD for the privacy bundle: CT viewing/spending keys + SPP root secret,
 * persisted locally via idb-keyval (backed by fake-indexeddb in this suite —
 * see vitest.setup.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { addressToField, toHex32 } from "@ctd/sdk";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { TESTNET } from "@grantfox/shared";

import { clearBundle, createBundle, loadBundle, saveBundle } from "./privacy-bundle.js";

// Deliberately NOT `TESTNET.ct.token`: this stands in for "the caller's newly
// deployed smart-account contract ID" (the real call site's argument), and
// must stay distinct from the token address so the addr_f test below can't
// pass by accident if `createBundle` were to (wrongly) derive addr_f from
// `cAddress` instead of the token — see the module doc on `createBundle`.
const A_CONTRACT_ADDRESS = TESTNET.smartAccount.webauthnVerifierAddress;
const AN_ACCOUNT_ADDRESS = Keypair.random().publicKey(); // valid G... address, invalid input

afterEach(async () => {
  await clearBundle();
});

describe("createBundle", () => {
  it("derives ctKeys bound to the CT token's addr_f, not the wallet address", () => {
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    expect(bundle.ctKeys.addrF).toBe(toHex32(addressToField(TESTNET.ct.token)));
    expect(bundle.ctKeys.addrF).toBe(toHex32(BigInt(TESTNET.ct.addrF)));
  });

  it("produces a fresh, valid-looking secret spending scalar each call", () => {
    const a = createBundle(A_CONTRACT_ADDRESS);
    const b = createBundle(A_CONTRACT_ADDRESS);
    expect(a.ctKeys.sk).not.toBe(b.ctKeys.sk);
    expect(a.ctKeys.sk).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("generates a distinct SPP root secret (Stellar S... seed) each call", () => {
    const a = createBundle(A_CONTRACT_ADDRESS);
    const b = createBundle(A_CONTRACT_ADDRESS);
    expect(a.sppRootSecret).not.toBe(b.sppRootSecret);
    expect(a.sppRootSecret.startsWith("S")).toBe(true);
    // Round-trips through Keypair.fromSecret without throwing == valid ed25519 seed.
    expect(() => Keypair.fromSecret(a.sppRootSecret)).not.toThrow();
  });

  it("stamps createdAt with a parseable ISO timestamp", () => {
    const before = Date.now();
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    const after = Date.now();
    const stamp = new Date(bundle.createdAt).getTime();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it("rejects a non-contract address (e.g. a G... account address)", () => {
    expect(StrKey.isValidContract(AN_ACCOUNT_ADDRESS)).toBe(false);
    expect(() => createBundle(AN_ACCOUNT_ADDRESS)).toThrow();
  });
});

describe("saveBundle / loadBundle", () => {
  it("returns undefined when nothing has been saved yet", async () => {
    await expect(loadBundle()).resolves.toBeUndefined();
  });

  it("round-trips a bundle through IndexedDB storage byte-for-byte", async () => {
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    await saveBundle(bundle);
    await expect(loadBundle()).resolves.toEqual(bundle);
  });

  it("clearBundle removes the persisted bundle", async () => {
    await saveBundle(createBundle(A_CONTRACT_ADDRESS));
    await clearBundle();
    await expect(loadBundle()).resolves.toBeUndefined();
  });
});
