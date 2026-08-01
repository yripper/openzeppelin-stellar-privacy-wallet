/**
 * Restore-from-backup: reached when a connected wallet has no privacy bundle
 * in this browser's IndexedDB (new device, cleared storage). Decrypts the
 * backup file client-side and persists the recovered bundle locally.
 */
import { useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";

import { importBackup } from "../lib/backup.js";
import { saveBundle } from "../lib/privacy-bundle.js";
import { useWallet } from "../providers/WalletProvider.js";

export default function RestoreBackup() {
  const { refreshBundle } = useWallet();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const bundle = await importBackup(file, passphrase);
      await saveBundle(bundle);
      await refreshBundle();
      navigate("/wallet", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1>Restore from backup</h1>
      <p>
        This browser doesn't have your privacy keys yet. Upload the encrypted
        backup file you downloaded during onboarding and enter its passphrase.
      </p>
      <form onSubmit={handleSubmit} className="stack">
        <label htmlFor="backupFile">Backup file</label>
        <input
          id="backupFile"
          type="file"
          accept="application/json"
          onChange={handleFileChange}
          disabled={busy}
          required
        />
        <label htmlFor="restorePassphrase">Backup passphrase</label>
        <input
          id="restorePassphrase"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          disabled={busy}
          required
        />
        <button type="submit" disabled={busy || !file}>
          {busy ? "Decrypting…" : "Restore"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </main>
  );
}
