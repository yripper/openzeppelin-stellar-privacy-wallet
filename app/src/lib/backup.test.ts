/**
 * TDD for the backup envelope: PBKDF2(SHA-256, 600_000 iters) -> AES-256-GCM,
 * exercised against Node's native WebCrypto (`globalThis.crypto.subtle`).
 */
import { describe, expect, it } from "vitest";

import type { PrivacyBundle } from "./privacy-bundle.js";
import { BackupDecryptionError, exportBackup, importBackup } from "./backup.js";

const SAMPLE_BUNDLE: PrivacyBundle = {
  ctKeys: {
    sk: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
    addrF: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
  },
  sppRootSecret: "SBZC6Y2Y7Q3ZQ2Y4QZJ2XZ3Z5YXZ6Z7Z2Y4QZJ2XZ3Z5YXZ6Z7Z2Y4QZQABCD",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const PASSPHRASE = "correct horse battery staple";

describe("exportBackup / importBackup", () => {
  it("round-trips a bundle byte-exact through export -> import", async () => {
    const blob = await exportBackup(SAMPLE_BUNDLE, PASSPHRASE);
    expect(blob).toBeInstanceOf(Blob);
    const restored = await importBackup(blob, PASSPHRASE);
    expect(restored).toEqual(SAMPLE_BUNDLE);
  });

  it("writes a v1 JSON envelope with base64 salt/iv/ct fields", async () => {
    const blob = await exportBackup(SAMPLE_BUNDLE, PASSPHRASE);
    const text = await blob.text();
    const envelope = JSON.parse(text);
    expect(envelope.v).toBe(1);
    expect(typeof envelope.salt).toBe("string");
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.ct).toBe("string");
    // base64 alphabet only
    expect(envelope.salt).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(envelope.iv).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(envelope.ct).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("uses a fresh random salt and IV on every export (no nonce reuse)", async () => {
    const first = JSON.parse(await (await exportBackup(SAMPLE_BUNDLE, PASSPHRASE)).text());
    const second = JSON.parse(await (await exportBackup(SAMPLE_BUNDLE, PASSPHRASE)).text());
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
  });

  it("rejects the wrong passphrase with a clean, typed error (GCM auth failure)", async () => {
    const blob = await exportBackup(SAMPLE_BUNDLE, PASSPHRASE);
    await expect(importBackup(blob, "wrong passphrase")).rejects.toBeInstanceOf(
      BackupDecryptionError
    );
  });

  it("rejects a corrupted envelope the same clean way", async () => {
    const blob = await exportBackup(SAMPLE_BUNDLE, PASSPHRASE);
    const envelope = JSON.parse(await blob.text());
    envelope.ct = envelope.ct.slice(0, -4) + (envelope.ct.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    const tampered = new Blob([JSON.stringify(envelope)], { type: "application/json" });
    await expect(importBackup(tampered, PASSPHRASE)).rejects.toBeInstanceOf(BackupDecryptionError);
  });
});
