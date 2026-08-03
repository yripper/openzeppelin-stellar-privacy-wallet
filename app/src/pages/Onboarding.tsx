/**
 * First-time-user flow: passkey-create a smart account, fund it via
 * friendbot, mint the privacy bundle, then go straight to the wallet.
 *
 * The backup export is NOT a gate here any more. It used to be — this page
 * navigated to `/backup-export`, which held "Continue" disabled until a file
 * had been downloaded — but a hard stop on a throwaway testnet wallet, in
 * front of the very first thing a new user sees, costs more than it protects.
 * The reminder now lives in `Shell`'s banner and persists until an export
 * actually happens (see `lib/backup-state.ts`).
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

import { useWallet } from "../providers/WalletProvider.js";

export default function Onboarding() {
  const { createWallet } = useWallet();
  const navigate = useNavigate();
  const [userName, setUserName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userName.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await createWallet(userName.trim());
      navigate("/wallet", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1>Create your wallet</h1>
      <p>
        Privacy Wallet creates a passkey-secured smart account on Stellar testnet. Your
        device will prompt you to create a passkey — no seed phrase to write down.
      </p>
      <form onSubmit={handleSubmit} className="stack">
        <label htmlFor="userName">Display name</label>
        <input
          id="userName"
          name="userName"
          type="text"
          autoComplete="username"
          placeholder="e.g. jane@example.com"
          value={userName}
          onChange={(event) => setUserName(event.target.value)}
          disabled={busy}
          required
        />
        <button type="submit" disabled={busy || !userName.trim()}>
          {busy ? "Creating wallet…" : "Create wallet with passkey"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <p className="muted">
        Already have a wallet? <a href="/connect">Connect with your passkey</a> instead.
      </p>
    </main>
  );
}
