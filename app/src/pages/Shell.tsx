/**
 * Wallet home / shell layout. Three tabs:
 * - "Wallet" — the Confidential Token dashboard (Task 11:
 *   register/deposit/merge/withdraw/send/activity, `pages/Confidential.tsx`).
 * - "Shielded" — the Selective Privacy Pool rail (Task 12: fund/shield/send/
 *   unshield/sweep, `pages/Shielded.tsx`).
 * - "Activity" — the unified CT + SPP-boundary-events view (Task 14,
 *   additive: both per-rail tabs above keep their own activity/history
 *   surfaces unchanged; see `pages/Activity.tsx`'s module doc).
 *
 * Also the permanent home of the backup reminder, now that onboarding no
 * longer forces an export before the wallet is reachable (see
 * `lib/backup-state.ts`). The banner is the ONLY entry point to
 * `/backup-export` for an existing wallet, so it stays until an export
 * happens rather than being dismissible.
 *
 * The header address is a copy button, not a label: a C-address is what
 * someone else needs in order to send this wallet a confidential transfer
 * (`SendForm.tsx` rejects G-addresses outright), so getting it onto the
 * clipboard is a primary task, not a detail-panel lookup.
 */
import { useState } from "react";
import { Link } from "react-router";

import { useWallet } from "../providers/WalletProvider.js";
import { hasBackedUp } from "../lib/backup-state.js";
import Confidential from "./Confidential.js";
import Shielded from "./Shielded.js";
import Activity from "./Activity.js";

const TABS = ["Wallet", "Shielded", "Activity"] as const;
type Tab = (typeof TABS)[number];

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function AddressPill({ contractId }: { contractId: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="address-pill"
      title={`Copy ${contractId}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(contractId)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          // No clipboard permission (or a non-secure origin) is not worth an
          // error state — the full address is still in the title and in the
          // wallet details panel.
          .catch(() => undefined);
      }}
    >
      {copied ? "Copied" : truncate(contractId)}
    </button>
  );
}

export default function Shell() {
  const { contractId, credentialId, bundle } = useWallet();
  const [activeTab, setActiveTab] = useState<Tab>("Wallet");
  const backedUp = hasBackedUp(contractId);

  return (
    <div className="shell">
      <header className="shell-header">
        <strong>
          <span className="mark" aria-hidden="true">
            <i />
            <i />
          </span>
          Privacy Wallet
        </strong>
        {contractId ? <AddressPill contractId={contractId} /> : null}
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
        {bundle && !backedUp ? (
          <div className="callout banner">
            <div className="callout-body">
              <strong>Your privacy keys only exist in this browser</strong>
              <span>
                They are not derived from your passkey and cannot be rebuilt from the chain. Clear
                this browser&apos;s storage without a backup and the confidential funds are gone.
              </span>
            </div>
            <Link className="button-link" to="/backup-export">
              Back up keys
            </Link>
          </div>
        ) : null}

        {activeTab === "Wallet" ? (
          <>
            <Confidential />
            <details className="info-tip wallet-details">
              <summary>Wallet details</summary>
              <dl className="details">
                <dt>Smart account</dt>
                <dd>{contractId ?? "—"}</dd>
                <dt>Passkey credential</dt>
                <dd>{credentialId ? truncate(credentialId) : "—"}</dd>
                <dt>Privacy bundle</dt>
                <dd>
                  {bundle ? `created ${new Date(bundle.createdAt).toLocaleString()}` : "missing"}
                </dd>
              </dl>
            </details>
          </>
        ) : activeTab === "Shielded" ? (
          <Shielded />
        ) : (
          <Activity />
        )}
      </main>
    </div>
  );
}
