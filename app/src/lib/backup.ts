/**
 * Encrypted backup envelope for a {@link PrivacyBundle}.
 *
 * The bundle holds the only copies of the CT spending key and the SPP root
 * secret; IndexedDB doesn't travel across devices/browsers, so this is the
 * user's disaster-recovery path. WebCrypto only (no third-party crypto lib):
 * PBKDF2(SHA-256, 600_000 iterations, random 16-byte salt) derives an
 * AES-256-GCM key; a random 12-byte IV encrypts the JSON-serialized bundle.
 * GCM's authentication tag means a wrong passphrase or a corrupted file both
 * fail decryption the same way, surfaced here as one clean
 * {@link BackupDecryptionError} instead of WebCrypto's opaque `OperationError`.
 */
import type { PrivacyBundle } from "./privacy-bundle.js";

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const BACKUP_VERSION = 1;

export interface BackupEnvelope {
  v: typeof BACKUP_VERSION;
  /** base64 */
  salt: string;
  /** base64 */
  iv: string;
  /** base64 (ciphertext + GCM auth tag) */
  ct: string;
}

export class BackupDecryptionError extends Error {
  constructor(message = "Could not decrypt backup: wrong passphrase or corrupted file.") {
    super(message);
    this.name = "BackupDecryptionError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt `bundle` under `passphrase`, returning a downloadable JSON {@link Blob}. */
export async function exportBackup(bundle: PrivacyBundle, passphrase: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveAesKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext);

  const envelope: BackupEnvelope = {
    v: BACKUP_VERSION,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext)),
  };
  return new Blob([JSON.stringify(envelope)], { type: "application/json" });
}

/** Decrypt a backup {@link Blob} under `passphrase`, recovering the {@link PrivacyBundle}. */
export async function importBackup(file: Blob, passphrase: string): Promise<PrivacyBundle> {
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(await file.text()) as BackupEnvelope;
  } catch {
    throw new BackupDecryptionError("Backup file is not valid JSON.");
  }
  if (envelope.v !== BACKUP_VERSION || !envelope.salt || !envelope.iv || !envelope.ct) {
    throw new BackupDecryptionError("Unrecognized backup format.");
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ct);
  const key = await deriveAesKey(passphrase, salt);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as PrivacyBundle;
  } catch {
    throw new BackupDecryptionError();
  }
}
