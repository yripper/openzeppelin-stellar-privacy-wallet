/**
 * The privacy bundle: everything the wallet needs to view/spend Confidential
 * Token balances and originate SPP (Selective Privacy Pool) notes, generated
 * once at onboarding and never sent to the backend (the backend only ever
 * sees on-chain ciphertext/commitments, never these secrets).
 *
 * Persisted locally via idb-keyval (a thin IndexedDB wrapper) so it survives
 * reloads; `backup.ts` encrypts it for user-controlled export/import since
 * IndexedDB itself is not portable across devices/browsers.
 */
import { get, set, del } from "idb-keyval";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { addressToField, generateKeys, serializeKeys, type SerializedKeyPair } from "@ctd/sdk";
import { TESTNET } from "@grantfox/shared";

export interface PrivacyBundle {
  /** CT viewing/spending key material, serialized as `{ sk, addrF }` hex. */
  ctKeys: SerializedKeyPair;
  /** Ed25519 secret seed (`S...`) that roots this wallet's SPP notes. */
  sppRootSecret: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /**
   * Contract id (`C...`) of the smart-account wallet this bundle is paired
   * to. Without this, this browser's single IndexedDB bundle slot has no
   * concept of ownership: create wallet A, create wallet B (same browser,
   * `saveBundle` overwrites unconditionally), then reconnect A used to hand
   * A the bundle B just minted — A's balance would fail to decrypt with no
   * explanation. Bundles saved before this field existed have it
   * `undefined` at runtime despite this type saying `string` (IndexedDB
   * doesn't enforce the shape) — callers MUST go through
   * `resolveBundleForWallet`/`pairImportedBundle`, not raw `loadBundle`, to
   * get that legacy case (and a real mismatch) handled consistently.
   */
  walletContractId: string;
}

const STORAGE_KEY = "grantfox:privacy-bundle";

/**
 * CT keys are bound to the TOKEN contract's `addr_f`, not the smart
 * account's — every wallet on a given deployment shares the same domain
 * separator (see packages/ctd-sdk/src/crypto/keys.ts's module doc: "every
 * key is contract-bound" to `addr_f`). This guards against silent Poseidon2
 * drift between this app's `@ctd/sdk` build and the deployed token, the same
 * assertion `scripts/smoke-ct.ts` makes on the Node side (smoke-ct.ts:372-375).
 */
function assertAddrFMatchesDeployedToken(): bigint {
  const computed = addressToField(TESTNET.ct.token);
  const expected = BigInt(TESTNET.ct.addrF);
  if (computed !== expected) {
    throw new Error(
      `CT addr_f drift: computed 0x${computed.toString(16)} does not match ` +
        `configured TESTNET.ct.addrF (${TESTNET.ct.addrF}) for token ${TESTNET.ct.token}`
    );
  }
  return computed;
}

/**
 * Create a fresh privacy bundle.
 *
 * @param cAddress - The wallet's smart-account contract address. NOT used to
 *   derive `ctKeys` (those bind to the CT token's `addr_f`, always
 *   `TESTNET.ct.token` here — see {@link assertAddrFMatchesDeployedToken}).
 *   Validated as a real contract address so a caller can't accidentally pass
 *   the wrong kind of string (e.g. a G... account address) at the one call
 *   site (post wallet-creation) where this matters.
 */
export function createBundle(cAddress: string): PrivacyBundle {
  if (!StrKey.isValidContract(cAddress)) {
    throw new Error(`createBundle: expected a contract (C...) address, got: ${cAddress}`);
  }
  const addrF = assertAddrFMatchesDeployedToken();
  const ctKeys = serializeKeys(generateKeys(addrF));
  const sppRootSecret = Keypair.random().secret();
  return { ctKeys, sppRootSecret, createdAt: new Date().toISOString(), walletContractId: cAddress };
}

export async function saveBundle(bundle: PrivacyBundle): Promise<void> {
  await set(STORAGE_KEY, bundle);
}

export async function loadBundle(): Promise<PrivacyBundle | undefined> {
  return get<PrivacyBundle>(STORAGE_KEY);
}

/** Used by tests and the restore-from-backup flow (overwriting a stale bundle). */
export async function clearBundle(): Promise<void> {
  await del(STORAGE_KEY);
}

export interface BundleLookupResult {
  /** Safe to use for this session, or `undefined` if nothing usable is stored. */
  bundle: PrivacyBundle | undefined;
  /** True when a bundle IS stored locally but is paired to a DIFFERENT wallet. */
  mismatch: boolean;
}

/**
 * The one safe way to hand a stored bundle to a session connecting as
 * `contractId` — used by `WalletProvider`'s silent session-restore and
 * `connectExisting`, both of which used to call `loadBundle()` directly
 * with no ownership check at all.
 *
 * - No stored bundle -> `{bundle: undefined, mismatch: false}`.
 * - Stored bundle's `walletContractId` matches -> handed over as-is.
 * - Stored bundle predates this field (`walletContractId` falsy — legacy,
 *   unknown owner) -> accepted AND stamped with `contractId` (persisted),
 *   the safer-but-not-annoying choice: this repo only ever shipped
 *   single-wallet-per-browser before pairing existed, so treating a legacy
 *   bundle as belonging to whoever connects next is correct for every
 *   bundle that predates this fix, and self-heals the ambiguity for good.
 * - Stored bundle's `walletContractId` names a DIFFERENT wallet -> the
 *   bundle is withheld (`bundle: undefined`) and left untouched on disk;
 *   `mismatch: true` tells the caller to route to restore-from-backup
 *   instead of silently handing over the wrong keys.
 */
export async function resolveBundleForWallet(contractId: string): Promise<BundleLookupResult> {
  const stored = await loadBundle();
  if (!stored) return { bundle: undefined, mismatch: false };
  if (!stored.walletContractId) {
    const stamped: PrivacyBundle = { ...stored, walletContractId: contractId };
    await saveBundle(stamped);
    return { bundle: stamped, mismatch: false };
  }
  if (stored.walletContractId !== contractId) {
    return { bundle: undefined, mismatch: true };
  }
  return { bundle: stored, mismatch: false };
}

export class BundleOwnerMismatchError extends Error {
  constructor(
    public readonly bundleOwner: string,
    public readonly connectedWallet: string
  ) {
    super(
      `This backup belongs to wallet ${bundleOwner}, not the connected wallet ${connectedWallet}. ` +
        "Restore the correct wallet's backup file instead."
    );
    this.name = "BundleOwnerMismatchError";
  }
}

/**
 * Reconciles an imported (restore-from-backup) bundle against the
 * currently connected wallet's contract id — the restore-from-backup path
 * needs the SAME pairing invariant `resolveBundleForWallet` enforces for
 * ordinary load, otherwise uploading the wrong backup file is a second way
 * to end up with a wallet/bundle mismatch. A legacy import (no
 * `walletContractId`, backed up before this field existed) is stamped with
 * `contractId`, not rejected — same rationale as the legacy branch above.
 * Pure (no IndexedDB access) so it's trivially unit-testable; the caller is
 * responsible for `saveBundle`-ing the result.
 */
export function pairImportedBundle(imported: PrivacyBundle, contractId: string): PrivacyBundle {
  if (!imported.walletContractId) {
    return { ...imported, walletContractId: contractId };
  }
  if (imported.walletContractId !== contractId) {
    throw new BundleOwnerMismatchError(imported.walletContractId, contractId);
  }
  return imported;
}
