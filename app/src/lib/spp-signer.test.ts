/**
 * `SessionSigner` unit tests.
 *
 * The three properties the SPP SDK actually depends on, each asserted against
 * an INDEPENDENT implementation rather than a re-run of the code under test:
 *
 * 1. `signMessage` is deterministic and 64 bytes — the SDK base64-decodes it
 *    and refuses anything else (`derive_membership_blinding`'s
 *    `signature.len() != 64` guard), and derive-once key reproducibility from
 *    a restored backup rests entirely on determinism.
 * 2. `signTransaction` round-trips a real envelope with a valid appended
 *    signature (verified here against the transaction hash the network itself
 *    checks, not against the signer's own output).
 * 3. `signAuthEntry` signs SHA-256 of the DECODED preimage bytes. The digest is
 *    recomputed here with `node:crypto`'s `createHash` (the implementation uses
 *    WebCrypto), and the test also proves the two plausible wrong answers —
 *    hashing the base64 TEXT, or signing the raw bytes unhashed — do NOT verify.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { SessionSigner, sessionKeypair } from "./spp-signer.js";

/** A fixed secret so the deterministic-signature assertions are reproducible across runs. */
const SESSION_SECRET = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
const SESSION_PUBLIC = "GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGF";

const KEY_DERIVATION_MESSAGE = "Privacy Pool Key Derivation [v1]";

function signer(secret: string = SESSION_SECRET): SessionSigner {
  return new SessionSigner(Keypair.fromSecret(secret), Networks.TESTNET);
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** A realistic Soroban auth preimage: exactly the shape `AuthSignStep::wallet_preimage_b64` emits. */
function authPreimageBase64(): string {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(
          "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI"
        ).toScAddress(),
        functionName: "transact",
        args: [],
      })
    ),
    subInvocations: [],
  });
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: xdr.Int64.fromString("123456789"),
      signatureExpirationLedger: 1000,
      invocation,
    })
  ).toXDR("base64");
}

function unsignedEnvelopeBase64(source: string): string {
  return new TransactionBuilder(new Account(source, "41"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N",
        asset: Asset.native(),
        amount: "10",
      })
    )
    .setTimeout(60)
    .build()
    .toXDR();
}

describe("sessionKeypair", () => {
  it("derives the session G-address from the bundle's SPP root secret", () => {
    expect(sessionKeypair(SESSION_SECRET).publicKey()).toBe(SESSION_PUBLIC);
  });
});

describe("SessionSigner.getPublicKey", () => {
  it("returns the session G-address (the SDK's `userAddress`)", async () => {
    await expect(signer().getPublicKey()).resolves.toBe(SESSION_PUBLIC);
  });
});

describe("SessionSigner.signMessage", () => {
  it("is deterministic: the same message signed twice yields byte-identical base64", async () => {
    const first = await signer().signMessage(KEY_DERIVATION_MESSAGE);
    const second = await signer().signMessage(KEY_DERIVATION_MESSAGE);
    expect(second).toBe(first);
  });

  it("is reproducible across independently constructed signers (backup restore)", async () => {
    const original = await signer().signMessage(KEY_DERIVATION_MESSAGE);
    // A restored wallet rebuilds the keypair from the same `sppRootSecret`
    // string in the decrypted backup — nothing else carries over.
    const restored = await new SessionSigner(
      sessionKeypair(SESSION_SECRET),
      Networks.TESTNET
    ).signMessage(KEY_DERIVATION_MESSAGE);
    expect(restored).toBe(original);
  });

  it("returns exactly 64 base64-decoded bytes (the SDK's ed25519 length guard)", async () => {
    const bytes = base64ToBytes(await signer().signMessage(KEY_DERIVATION_MESSAGE));
    expect(bytes.length).toBe(64);
  });

  it("signs the message's raw UTF-8 bytes (verifiable with the session public key)", async () => {
    const signature = base64ToBytes(await signer().signMessage(KEY_DERIVATION_MESSAGE));
    const verifier = Keypair.fromPublicKey(SESSION_PUBLIC);
    expect(verifier.verify(Buffer.from(KEY_DERIVATION_MESSAGE, "utf8"), Buffer.from(signature))).toBe(
      true
    );
  });

  it("produces different signatures for different messages", async () => {
    const a = await signer().signMessage(KEY_DERIVATION_MESSAGE);
    const b = await signer().signMessage("Privacy Pool Key Derivation [v2]");
    expect(b).not.toBe(a);
  });
});

describe("SessionSigner.signTransaction", () => {
  it("round-trips the envelope with one appended, valid signature", async () => {
    const unsigned = unsignedEnvelopeBase64(SESSION_PUBLIC);
    const signedXdr = await signer().signTransaction(unsigned);

    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    expect(signed.signatures).toHaveLength(1);

    // The signature the network verifies: over the transaction hash, by the
    // session key, with the matching 4-byte key hint.
    const kp = Keypair.fromSecret(SESSION_SECRET);
    expect(signed.signatures[0]!.hint()).toEqual(kp.signatureHint());
    expect(kp.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
  });

  it("preserves the transaction body (same hash as the unsigned envelope)", async () => {
    const unsigned = unsignedEnvelopeBase64(SESSION_PUBLIC);
    const before = (TransactionBuilder.fromXDR(unsigned, Networks.TESTNET) as Transaction).hash();
    const after = (
      TransactionBuilder.fromXDR(
        await signer().signTransaction(unsigned),
        Networks.TESTNET
      ) as Transaction
    ).hash();
    expect(after.toString("hex")).toBe(before.toString("hex"));
  });
});

describe("SessionSigner.signAuthEntry", () => {
  it("signs SHA-256 of the DECODED preimage bytes", async () => {
    const preimageB64 = authPreimageBase64();
    const signature = base64ToBytes(await signer().signAuthEntry(preimageB64));

    // Independent digest: node:crypto, not the WebCrypto call the implementation makes.
    const expectedDigest = createHash("sha256").update(Buffer.from(preimageB64, "base64")).digest();

    const verifier = Keypair.fromPublicKey(SESSION_PUBLIC);
    expect(verifier.verify(expectedDigest, Buffer.from(signature))).toBe(true);
    expect(signature.length).toBe(64);
  });

  it("does NOT sign the hash of the base64 TEXT (the classic off-by-encoding bug)", async () => {
    const preimageB64 = authPreimageBase64();
    const signature = base64ToBytes(await signer().signAuthEntry(preimageB64));

    const wrongDigest = createHash("sha256").update(Buffer.from(preimageB64, "utf8")).digest();
    const verifier = Keypair.fromPublicKey(SESSION_PUBLIC);
    expect(verifier.verify(wrongDigest, Buffer.from(signature))).toBe(false);
  });

  it("does NOT sign the raw preimage bytes unhashed", async () => {
    const preimageB64 = authPreimageBase64();
    const signature = base64ToBytes(await signer().signAuthEntry(preimageB64));

    const verifier = Keypair.fromPublicKey(SESSION_PUBLIC);
    expect(verifier.verify(Buffer.from(preimageB64, "base64"), Buffer.from(signature))).toBe(false);
  });

  it("is deterministic for the same preimage", async () => {
    const preimageB64 = authPreimageBase64();
    const first = await signer().signAuthEntry(preimageB64);
    const second = await signer().signAuthEntry(preimageB64);
    expect(second).toBe(first);
  });
});
