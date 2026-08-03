/**
 * Backup export: writes the privacy bundle (CT keys + SPP root secret) out as
 * a passphrase-encrypted file, since IndexedDB doesn't survive a lost device
 * or cleared browser. This app never sees the plaintext bundle leave the
 * browser — `exportBackup` runs entirely client-side and nothing here posts
 * anywhere.
 *
 * Reached from `Shell`'s reminder banner. No longer a gate in the onboarding
 * flow (see `pages/Onboarding.tsx`), so leaving is always allowed; a
 * successful export records the fact via `markBackedUp` and that is what
 * retires the banner.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

import { exportBackup } from "../lib/backup.js";
import { markBackedUp } from "../lib/backup-state.js";
import { useWallet } from "../providers/WalletProvider.js";

export default function BackupExport() {
  const { bundle, contractId } = useWallet();
  const navigate = useNavigate();
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [hasExported, setHasExported] = useState(false);

  if (!bundle) {
    return (
      <main className="screen">
        <h1>No wallet to back up yet</h1>
        <p>Create a wallet first.</p>
        <a href="/onboarding">Back to onboarding</a>
      </main>
    );
  }

  async function handleExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !bundle) return;
    if (passphrase.length < 8) {
      setError("Use a passphrase of at least 8 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases do not match.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const blob = await exportBackup(bundle, passphrase);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `privacy-wallet-backup-${contractId?.slice(0, 8) ?? "wallet"}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setHasExported(true);
      markBackedUp(contractId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1>Back up your wallet</h1>
      <p>
        This file is the only way to recover your privacy keys on another
        device or browser. Choose a passphrase you'll remember — losing both
        the file and the passphrase means losing access permanently.
      </p>
      <form onSubmit={handleExport} className="stack">
        <label htmlFor="passphrase">Backup passphrase</label>
        <input
          id="passphrase"
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          disabled={busy}
          required
        />
        <label htmlFor="confirmPassphrase">Confirm passphrase</label>
        <input
          id="confirmPassphrase"
          type="password"
          autoComplete="new-password"
          value={confirmPassphrase}
          onChange={(event) => setConfirmPassphrase(event.target.value)}
          disabled={busy}
          required
        />
        <button type="submit" disabled={busy}>
          {busy ? "Encrypting…" : hasExported ? "Download again" : "Download encrypted backup"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        className={hasExported ? undefined : "btn-ghost"}
        onClick={() => navigate("/wallet", { replace: true })}
      >
        {hasExported ? "I've saved my backup — back to wallet" : "Back to wallet"}
      </button>
    </main>
  );
}
