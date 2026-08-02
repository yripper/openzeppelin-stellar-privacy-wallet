/**
 * Returning-user flow: authenticate with the existing passkey and restore
 * the smart-account session. If the privacy bundle isn't in this browser's
 * IndexedDB (new device, cleared storage) OR it's paired to a DIFFERENT
 * wallet (`WalletProvider`'s `bundleMismatch` — this browser's bundle slot
 * holds another wallet's keys), send the user to restore from an encrypted
 * backup instead of silently proceeding without/with-the-wrong CT/SPP keys.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import { useWallet } from "../providers/WalletProvider.js";

export default function Connect() {
  const { connectExisting } = useWallet();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleConnect() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { bundleMissing, bundleMismatch } = await connectExisting();
      navigate(bundleMissing ? "/restore" : "/wallet", {
        replace: true,
        state: bundleMismatch ? { mismatch: true } : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1>Connect your wallet</h1>
      <p>Authenticate with the passkey you created for this wallet.</p>
      <button type="button" onClick={handleConnect} disabled={busy}>
        {busy ? "Waiting for passkey…" : "Connect with passkey"}
      </button>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <p className="muted">
        New here? <a href="/onboarding">Create a wallet</a> instead.
      </p>
    </main>
  );
}
