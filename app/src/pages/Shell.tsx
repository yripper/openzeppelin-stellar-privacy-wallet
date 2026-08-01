/**
 * Wallet home / shell layout. The tab bar is a placeholder for the flows
 * later tasks add (Task 11: CT send/receive, Task 12: SPP deposit/withdraw,
 * a later task: activity feed) — this task only scaffolds the shell and
 * onboarding, so the non-Wallet tabs render a "coming soon" stub.
 */
import { useState } from "react";

import { useWallet } from "../providers/WalletProvider.js";

const TABS = ["Wallet", "Send", "Deposit", "Activity"] as const;
type Tab = (typeof TABS)[number];

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export default function Shell() {
  const { contractId, credentialId, bundle } = useWallet();
  const [activeTab, setActiveTab] = useState<Tab>("Wallet");

  return (
    <div className="shell">
      <header className="shell-header">
        <strong>GrantFox</strong>
        {contractId ? (
          <code title={contractId} className="address-pill">
            {truncate(contractId)}
          </code>
        ) : null}
      </header>

      <nav className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={tab === activeTab ? "tab active" : "tab"}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      <main className="screen">
        {activeTab === "Wallet" ? (
          <>
            <h1>Wallet</h1>
            <dl className="details">
              <dt>Smart account</dt>
              <dd>{contractId ?? "—"}</dd>
              <dt>Passkey credential</dt>
              <dd>{credentialId ? truncate(credentialId) : "—"}</dd>
              <dt>Privacy bundle</dt>
              <dd>{bundle ? `created ${new Date(bundle.createdAt).toLocaleString()}` : "missing"}</dd>
            </dl>
          </>
        ) : (
          <>
            <h1>{activeTab}</h1>
            <p className="muted">Coming soon.</p>
          </>
        )}
      </main>
    </div>
  );
}
