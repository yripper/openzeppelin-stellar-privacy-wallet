/**
 * Entry point: silently tries to restore a session (WalletProvider does this
 * on mount); once we know the answer, routes to the wallet home (or, on a
 * wallet/bundle pairing mismatch, restore-from-backup), or offers the
 * create-vs-connect choice.
 */
import { Navigate, useNavigate } from "react-router";

import { useWallet } from "../providers/WalletProvider.js";

export default function Landing() {
  const { status, bundleMismatch } = useWallet();
  const navigate = useNavigate();

  if (status === "restoring") {
    return (
      <main className="screen">
        <p>Checking for an existing session…</p>
      </main>
    );
  }

  if (status === "connected") {
    // A silently-restored session can hit the same wallet/bundle pairing
    // mismatch `connectExisting` guards against (see `WalletProvider`'s
    // module doc) — route to restore-from-backup instead of the wallet
    // home, same as `Connect.tsx` does for a fresh connect.
    return (
      <Navigate
        to={bundleMismatch ? "/restore" : "/wallet"}
        replace
        state={bundleMismatch ? { mismatch: true } : undefined}
      />
    );
  }

  return (
    <main className="screen">
      <h1>Privacy Wallet</h1>
      <p>A passkey-secured Stellar smart account with confidential balances.</p>
      <div className="stack">
        <button type="button" onClick={() => navigate("/onboarding")}>
          Create a new wallet
        </button>
        <button type="button" onClick={() => navigate("/connect")}>
          I already have a wallet
        </button>
      </div>
    </main>
  );
}
