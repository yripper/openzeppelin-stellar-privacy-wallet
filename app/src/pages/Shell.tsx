/**
 * Wallet home / shell layout. Three tabs:
 * - "Wallet" — the Confidential Token dashboard (Task 11:
 *   register/deposit/merge/withdraw/send/activity, `pages/Confidential.tsx`).
 * - "Shielded" — the Selective Privacy Pool rail (Task 12: fund/shield/send/
 *   unshield/sweep, `pages/Shielded.tsx`).
 * - "Activity" — the unified CT + SPP-boundary-events view (Task 14,
 *   additive: both per-rail tabs above keep their own activity/history
 *   surfaces unchanged; see `pages/Activity.tsx`'s module doc).
 */
import { useState } from "react";

import { useWallet } from "../providers/WalletProvider.js";
import Confidential from "./Confidential.js";
import Shielded from "./Shielded.js";
import Activity from "./Activity.js";

const TABS = ["Wallet", "Shielded", "Activity"] as const;
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
            <Confidential />
          </>
        ) : activeTab === "Shielded" ? (
          <>
            <h1>Shielded</h1>
            <Shielded />
          </>
        ) : (
          <>
            <h1>Activity</h1>
            <Activity />
          </>
        )}
      </main>
    </div>
  );
}
