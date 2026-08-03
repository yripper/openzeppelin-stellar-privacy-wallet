/**
 * TDD for the privacy bundle: CT viewing/spending keys + SPP root secret,
 * persisted locally via idb-keyval (backed by fake-indexeddb in this suite —
 * see vitest.setup.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { addressToField, toHex32 } from "@ctd/sdk";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { TESTNET } from "@privacy-wallet/shared";

import {
  BundleOwnerMismatchError,
  clearBundle,
  createBundle,
  loadBundle,
  pairImportedBundle,
  type PrivacyBundle,
  resolveBundleForWallet,
  saveBundle,
} from "./privacy-bundle.js";

// Deliberately NOT `TESTNET.ct.token`: this stands in for "the caller's newly
// deployed smart-account contract ID" (the real call site's argument), and
// must stay distinct from the token address so the addr_f test below can't
// pass by accident if `createBundle` were to (wrongly) derive addr_f from
// `cAddress` instead of the token — see the module doc on `createBundle`.
const A_CONTRACT_ADDRESS = TESTNET.smartAccount.webauthnVerifierAddress;
// A second, distinct contract address — stands in for "a different wallet's
// contract ID" in the pairing tests below. Any valid C... address works;
// this repo's own SPP pool contract is a convenient, already-configured one.
const B_CONTRACT_ADDRESS = TESTNET.spp.pool;
const AN_ACCOUNT_ADDRESS = Keypair.random().publicKey(); // valid G... address, invalid input

/** Simulates a bundle saved before wallet-pairing existed: `walletContractId` absent at runtime, exactly as it would be once loaded back from a real pre-fix IndexedDB record — TS's `string` type on the field doesn't survive the storage round trip. */
function toLegacyBundle(bundle: PrivacyBundle): PrivacyBundle {
  const { walletContractId: _drop, ...rest } = bundle;
  return rest as PrivacyBundle;
}

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

  it("pairs the bundle to the wallet it was created for (walletContractId)", () => {
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    expect(bundle.walletContractId).toBe(A_CONTRACT_ADDRESS);
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

describe("resolveBundleForWallet (wallet/bundle pairing — final fix wave)", () => {
  it("returns undefined, not a mismatch, when nothing is stored yet", async () => {
    await expect(resolveBundleForWallet(A_CONTRACT_ADDRESS)).resolves.toEqual({
      bundle: undefined,
      mismatch: false,
    });
  });

  it("hands over a bundle whose walletContractId matches the connecting wallet", async () => {
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    await saveBundle(bundle);
    await expect(resolveBundleForWallet(A_CONTRACT_ADDRESS)).resolves.toEqual({
      bundle,
      mismatch: false,
    });
  });

  it("withholds a bundle paired to a DIFFERENT wallet (mismatch), and leaves it on disk untouched", async () => {
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    await saveBundle(bundle);

    const result = await resolveBundleForWallet(B_CONTRACT_ADDRESS);
    expect(result).toEqual({ bundle: undefined, mismatch: true });

    // The stored bundle must survive a mismatched lookup unmodified — a
    // mismatch is "wrong session", not "corrupt/delete the data".
    await expect(loadBundle()).resolves.toEqual(bundle);
  });

  it("accepts and stamps a legacy bundle (no walletContractId) with the connecting wallet, persisting the stamp", async () => {
    const legacy = toLegacyBundle(createBundle(A_CONTRACT_ADDRESS));
    await saveBundle(legacy);
    expect(legacy.walletContractId).toBeUndefined();

    const result = await resolveBundleForWallet(A_CONTRACT_ADDRESS);
    expect(result.mismatch).toBe(false);
    expect(result.bundle?.walletContractId).toBe(A_CONTRACT_ADDRESS);

    // The migration must be persisted, not just returned in-memory —
    // otherwise the very next resolve would still see an "unpaired" bundle.
    await expect(loadBundle()).resolves.toEqual(result.bundle);
  });
});

describe("pairImportedBundle (restore-from-backup pairing — final fix wave)", () => {
  it("passes through a bundle whose walletContractId already matches", () => {
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    expect(pairImportedBundle(bundle, A_CONTRACT_ADDRESS)).toEqual(bundle);
  });

  it("stamps a legacy import (no walletContractId) with the connected wallet", () => {
    const legacy = toLegacyBundle(createBundle(A_CONTRACT_ADDRESS));
    const paired = pairImportedBundle(legacy, B_CONTRACT_ADDRESS);
    expect(paired.walletContractId).toBe(B_CONTRACT_ADDRESS);
  });

  it("rejects a backup that belongs to a different wallet, instead of silently pairing it to the connected one", () => {
    const bundle = createBundle(A_CONTRACT_ADDRESS);
    expect(() => pairImportedBundle(bundle, B_CONTRACT_ADDRESS)).toThrow(BundleOwnerMismatchError);

    let caught: unknown;
    try {
      pairImportedBundle(bundle, B_CONTRACT_ADDRESS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleOwnerMismatchError);
    const mismatchErr = caught as BundleOwnerMismatchError;
    expect(mismatchErr.bundleOwner).toBe(A_CONTRACT_ADDRESS);
    expect(mismatchErr.connectedWallet).toBe(B_CONTRACT_ADDRESS);
  });
});
