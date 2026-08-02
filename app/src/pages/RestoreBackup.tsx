/**
 * Restore-from-backup: reached when a connected wallet has no privacy bundle
 * in this browser's IndexedDB (new device, cleared storage) OR the bundle
 * stored here is paired to a DIFFERENT wallet (`WalletProvider`'s
 * `bundleMismatch`, surfaced via router `state`). Decrypts the backup file
 * client-side, checks/stamps its `walletContractId` against the connected
 * wallet (`pairImportedBundle` — so uploading the wrong backup can't
 * reintroduce the same mismatch this screen exists to fix), and persists
 * the recovered bundle locally.
 */
import { useState, type ChangeEvent, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";

import { importBackup } from "../lib/backup.js";
import { pairImportedBundle, saveBundle } from "../lib/privacy-bundle.js";
import { useWallet } from "../providers/WalletProvider.js";

export default function RestoreBackup() {
  const { contractId, refreshBundle } = useWallet();
  const navigate = useNavigate();
  const location = useLocation();
  const cameFromMismatch = Boolean((location.state as { mismatch?: boolean } | null)?.mismatch);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!contractId) {
    return (
      <main className="screen">
        <h1>Connect a wallet first</h1>
        <p>Restoring a backup requires an active wallet session to pair it to.</p>
        <a href="/connect">Back to connect</a>
      </main>
    );
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy || !contractId) return;
    setBusy(true);
    setError(undefined);
    try {
      const imported = await importBackup(file, passphrase);
      const paired = pairImportedBundle(imported, contractId);
      await saveBundle(paired);
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
        {cameFromMismatch
          ? "This browser's privacy keys belong to a different wallet. Upload the encrypted backup for THIS wallet and enter its passphrase."
          : "This browser doesn't have your privacy keys yet. Upload the encrypted backup file you downloaded during onboarding and enter its passphrase."}
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
