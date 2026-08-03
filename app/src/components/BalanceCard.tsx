/**
 * Confidential balances: public XLM (SAC `balance` simulation) beside the
 * decrypted spendable balance (StateEngine), plus the two state-changing
 * actions that belong to the balance itself rather than to moving money —
 * `register` (first-time activation) and `merge` (receiving -> spendable).
 *
 * Deposit and withdraw used to live here too; they now sit in the segmented
 * action panel (`MoveFunds.tsx`, switched by `pages/Confidential.tsx`)
 * alongside send, because they are all the same kind of thing — moving an
 * amount across a boundary — and stacking every form at once was most of why
 * this page read as a form dump.
 *
 * The receiving balance is rendered as a prompt with the merge button
 * attached, not as a number the user is expected to notice. A deposit lands in
 * receiving and is NOT spendable until merged, which is the single most
 * confusing thing about the CT rail: "I deposited, why can't I send?"
 */
import { useState } from "react";

import { useCt } from "../providers/CtProvider.js";
import { stroopsToXlm } from "../lib/format.js";
import Amount from "./Amount.js";

type Action = "register" | "merge";

export default function BalanceCard() {
  const { rail, view, loading, error, refresh } = useCt();
  const [busy, setBusy] = useState<Action | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  async function run(action: Action, fn: () => Promise<unknown>): Promise<void> {
    setBusy(action);
    setActionError(undefined);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  if (!rail) {
    return (
      <section className="balance-card">
        <p className="muted">Loading confidential wallet…</p>
      </section>
    );
  }

  return (
    <section className="balance-card">
      <div className="card-header">
        <h2>Balances</h2>
        <button type="button" className="btn-ghost btn-small" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>

      {loading && !view ? <p className="muted">Reading your balances…</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}

      {view ? (
        <>
          <div className="cells">
            <div className="cell">
              <div className="cell-label">
                <span className="dot dot-exposed" /> Public
              </div>
              <Amount stroops={view.publicXlm} />
              <p className="cell-note">Printed on the ledger. Anyone can read it.</p>
            </div>

            <div className="cell redacted">
              <div className="cell-label">
                <span className="dot dot-veil" /> Confidential · spendable
              </div>
              <Amount stroops={view.spendable} reveal={view.registered ? "decrypted" : "plain"} />
              <p className="cell-note">
                {view.registered
                  ? "Decrypted here, with your viewing key."
                  : "Not activated yet."}
              </p>
            </div>
          </div>

          {view.registered ? (
            <p className="muted card-status">
              {view.matchesChain
                ? "Verified against the on-chain commitment."
                : "Verifying against the on-chain commitment…"}
            </p>
          ) : null}
        </>
      ) : null}

      {actionError ? (
        <p role="alert" className="error">
          {actionError}
        </p>
      ) : null}

      {!view?.registered ? (
        <button
          type="button"
          className={busy === "register" ? "btn-working" : undefined}
          disabled={busy !== undefined}
          onClick={() => void run("register", () => rail.register())}
        >
          <span>
            {busy === "register"
              ? "Proving in your browser… about 10 seconds"
              : "Activate confidential balance"}
          </span>
        </button>
      ) : null}

      {view && view.receiving > 0n ? (
        <div className="callout">
          <div className="callout-body">
            {/* Plain text, not <Amount>: the hero treatment's block layout and
                shrunken fraction fight a sentence. */}
            <strong>{stroopsToXlm(view.receiving)} XLM arrived</strong>
            <span>
              Deposits land in a receiving bucket. Move them to spendable before you can send.
            </span>
          </div>
          <button type="button" disabled={busy !== undefined} onClick={() => void run("merge", () => rail.merge())}>
            {busy === "merge" ? "Moving…" : "Move to spendable"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
