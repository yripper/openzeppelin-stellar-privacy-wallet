/**
 * `SessionSigner` — the ed25519 wallet adapter the Stellar Private Payments
 * (SPP) SDK signs with.
 *
 * ## Why a session key at all
 *
 * Every GrantFox wallet is a passkey smart account (a `C…` contract address),
 * but the SPP SDK is G-address-only at the parser level: `user_address` is fed
 * straight into `stellar_strkey::ed25519::PublicKey::parse` on both signing
 * paths (`unsigned_tx_for_signing`'s `user_address.parse()` and
 * `apply_address_auth_signature`'s 32-byte key argument —
 * `resources/stellar-private-payments/sdk/stellar/src/signer.rs:216-222`), and
 * the note/encryption keys are derived from a *raw 64-byte ed25519 signature*
 * (`sdk/prover/src/encryption.rs:50` + `derive_membership_blinding`'s explicit
 * `signature.len() != 64` guard). A WebAuthn assertion is neither.
 *
 * So the SPP rail runs on a session `G…` account deterministically derived from
 * `PrivacyBundle.sppRootSecret` (`Keypair.fromSecret`) — the same secret that
 * rides in the encrypted backup, so a restored wallet reproduces the same
 * session account AND (see `signMessage` below) the same privacy keys. The
 * smart account remains the user's actual wallet; the session account is a
 * short-lived staging address that funds get moved through (see `spp.ts`'s
 * `fundSession`/`sweepToWallet`).
 *
 * ## Contract with the SDK (verified line-by-line against the SDK source)
 *
 * The SDK invokes exactly three methods, each `(payload, opts) => Promise<string>`
 * (`sdk/web/src/signer.rs:16,96-119`; a plain string return is accepted directly,
 * `normalize_sign_result`, so no `{signedTxXdr}` wrapper is needed):
 *
 * - `signMessage(message)` — called once per account, from `Client::account`,
 *   with `KEY_DERIVATION_MESSAGE` (`sdk/web/src/client/mod.rs:196-210`). The
 *   result is base64-decoded (`wallet_message_signature_to_bytes`,
 *   `sdk/web/src/signer.rs:226-235`) and must be exactly 64 bytes. Ed25519 is
 *   deterministic per RFC 8032, so signing the raw UTF-8 message bytes makes
 *   the derived privacy keys reproducible from the backup alone. (Derive-once
 *   semantics live inside the SDK: it only calls this when
 *   `user_keys_exist(user_address)` is false.)
 * - `signTransaction(xdrBase64)` — a base64 unsigned v1 `TransactionEnvelope`;
 *   must return a base64 envelope with our `DecoratedSignature` appended
 *   (`sdk/web/src/signer.rs:75-83`).
 * - `signAuthEntry(preimageBase64)` — base64 XDR of a `HashIdPreimage`
 *   (`AuthSignStep::wallet_preimage_b64`, `sdk/stellar/src/signer.rs:186-192`).
 *   The signature must be over **SHA-256 of the decoded preimage bytes**, not
 *   over the base64 text and not over the raw bytes directly — that's what the
 *   in-process signer does (`LocalSigner::sign_auth_preimage` → `sign(&bytes)`
 *   → `sign_digest(Sha256::digest(data))`, `sdk/stellar/src/signer.rs:101-112`)
 *   and what the on-chain ed25519 auth check verifies.
 *
 * ## Browser notes
 *
 * `node:crypto`'s `createHash` does not exist in the browser, so the SHA-256
 * runs on WebCrypto (`crypto.subtle.digest`) and `signAuthEntry` is therefore
 * async — allowed, since `WalletSigner` types every method as `Promise`-returning
 * (`js/types/signer.d.ts`). `Buffer` is imported explicitly from the `buffer`
 * package (Vite aliases it to the browser polyfill, `vite.config.ts`'s
 * `resolve.alias`; Node resolves its own built-in) rather than assumed as a
 * global, and because `@stellar/stellar-sdk`'s `Keypair.sign` takes a `Buffer`
 * anyway.
 */
import { Buffer } from "buffer";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { WalletSigner } from "stellar-private-payments";

async function sha256(bytes: Buffer): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Buffer.from(digest);
}

/**
 * The wallet adapter passed to `client.account(...)`.
 *
 * Holds the session `Keypair` in memory only. Nothing here logs, serializes,
 * or otherwise emits the secret — the sole outputs are signatures.
 */
export class SessionSigner implements WalletSigner {
  constructor(
    private readonly keypair: Keypair,
    private readonly networkPassphrase: string
  ) {}

  /** Lets the SDK's JS wrapper resolve `userAddress` on its own (`js/index.js`'s `wrapClient.account`). */
  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  /**
   * Deterministic (RFC 8032) ed25519 signature over the message's raw UTF-8
   * bytes, base64-encoded. Same message + same secret => byte-identical output,
   * forever — which is what makes the SDK's derived note/encryption keys
   * recoverable from `sppRootSecret` alone.
   */
  async signMessage(message: string): Promise<string> {
    return this.keypair.sign(Buffer.from(message, "utf8")).toString("base64");
  }

  /** Append this session key's `DecoratedSignature` to a base64 transaction envelope. */
  async signTransaction(xdrBase64: string): Promise<string> {
    const tx = TransactionBuilder.fromXDR(xdrBase64, this.networkPassphrase);
    tx.sign(this.keypair);
    return tx.toXDR();
  }

  /**
   * Sign a Soroban auth entry: SHA-256 the DECODED `HashIdPreimage` bytes, then
   * sign that 32-byte digest (never the base64 string's own bytes — see the
   * module doc's `LocalSigner::sign_auth_preimage` reference).
   */
  async signAuthEntry(preimageXdrBase64: string): Promise<string> {
    const digest = await sha256(Buffer.from(preimageXdrBase64, "base64"));
    return this.keypair.sign(digest).toString("base64");
  }
}

/**
 * The SPP session account for a wallet's privacy bundle.
 *
 * Deliberately a separate export from `SessionSigner` so callers that only
 * need the `G…` address (funding checks, `recipientLookup`, withdraw
 * destination) never construct a signer.
 */
export function sessionKeypair(sppRootSecret: string): Keypair {
  return Keypair.fromSecret(sppRootSecret);
}
