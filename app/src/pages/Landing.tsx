/**
 * Entry point: silently tries to restore a session (WalletProvider does this
 * on mount); once we know the answer, routes to the wallet home, or offers
 * the create-vs-connect choice.
 */
import { Navigate, useNavigate } from "react-router";

import { useWallet } from "../providers/WalletProvider.js";

export default function Landing() {
  const { status } = useWallet();
  const navigate = useNavigate();

  if (status === "restoring") {
    return (
      <main className="screen">
        <p>Checking for an existing session…</p>
      </main>
    );
  }

  if (status === "connected") {
    return <Navigate to="/wallet" replace />;
  }

  return (
    <main className="screen">
      <h1>GrantFox Privacy Wallet</h1>
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
