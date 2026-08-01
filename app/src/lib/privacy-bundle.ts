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
  return { ctKeys, sppRootSecret, createdAt: new Date().toISOString() };
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
