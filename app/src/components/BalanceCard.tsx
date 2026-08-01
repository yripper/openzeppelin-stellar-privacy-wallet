/**
 * Confidential balance card: public XLM (SAC `balance` simulation) +
 * decrypted spendable/receiving (StateEngine), the on-chain verification
 * status, and the register/deposit/merge/withdraw quick actions —
 * `ct.ts`'s five orchestrator methods minus `transfer` (that one lives in
 * `SendForm.tsx`).
 */
import { useState, type FormEvent } from "react";

import { useCt } from "../providers/CtProvider.js";
import { stroopsToXlm, xlmToStroops } from "../lib/format.js";

type Action = "register" | "deposit" | "merge" | "withdraw";

export default function BalanceCard() {
  const { rail, view, loading, error, refresh } = useCt();
  const [busy, setBusy] = useState<Action | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

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
      <h2>Confidential balance</h2>
      {loading && !view ? <p className="muted">Syncing…</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}

      {view ? (
        <dl className="details">
          <dt>Public XLM</dt>
          <dd>{stroopsToXlm(view.publicXlm)} XLM</dd>
          <dt>Spendable</dt>
          <dd>{stroopsToXlm(view.spendable)} XLM</dd>
          <dt>Receiving</dt>
          <dd>{stroopsToXlm(view.receiving)} XLM</dd>
          <dt>Status</dt>
          <dd>
            {!view.registered
              ? "Not activated"
              : view.matchesChain
                ? "Activated · verified against chain"
                : "Activated · verifying…"}
          </dd>
        </dl>
      ) : null}

      {actionError ? (
        <p role="alert" className="error">
          {actionError}
        </p>
      ) : null}

      {!view?.registered ? (
        <button
          type="button"
          disabled={busy !== undefined}
          onClick={() => run("register", () => rail.register())}
        >
          {busy === "register" ? "Proving + activating…" : "Activate confidential balance"}
        </button>
      ) : (
        <div className="stack">
          <form
            className="stack"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              let stroops: bigint;
              try {
                stroops = xlmToStroops(depositAmount);
              } catch (err) {
                setActionError(err instanceof Error ? err.message : String(err));
                return;
              }
              void run("deposit", () => rail.deposit(stroops)).then(() => setDepositAmount(""));
            }}
          >
            <label htmlFor="depositAmount">Deposit public XLM into confidential balance</label>
            <input
              id="depositAmount"
              inputMode="decimal"
              placeholder="0.0000000"
              value={depositAmount}
              onChange={(event) => setDepositAmount(event.target.value)}
              disabled={busy !== undefined}
            />
            <button type="submit" disabled={busy !== undefined || !depositAmount}>
              {busy === "deposit" ? "Depositing…" : "Deposit"}
            </button>
          </form>

          {view && view.receiving > 0n ? (
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => run("merge", () => rail.merge())}
            >
              {busy === "merge" ? "Merging…" : "Merge receiving into spendable"}
            </button>
          ) : null}

          <form
            className="stack"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              let stroops: bigint;
              try {
                stroops = xlmToStroops(withdrawAmount);
              } catch (err) {
                setActionError(err instanceof Error ? err.message : String(err));
                return;
              }
              void run("withdraw", () => rail.withdraw(stroops)).then(() => setWithdrawAmount(""));
            }}
          >
            <label htmlFor="withdrawAmount">Withdraw confidential balance to public XLM</label>
            <input
              id="withdrawAmount"
              inputMode="decimal"
              placeholder="0.0000000"
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(event.target.value)}
              disabled={busy !== undefined}
            />
            <button type="submit" disabled={busy !== undefined || !withdrawAmount}>
              {busy === "withdraw" ? "Proving + withdrawing…" : "Withdraw"}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
