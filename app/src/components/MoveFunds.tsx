/**
 * The two CT actions that cross the public/private boundary: deposit (public
 * XLM -> confidential receiving) and withdraw (confidential -> public XLM).
 * Both are ONE form with different wiring, so they share a component rather
 * than being copy-pasted — the only differences are the orchestrator method,
 * the labels, and the proving cost.
 *
 * Both are labelled as publishing the amount on chain, because they do: the
 * CT contract's `deposit` emits `["deposit", from, to]` with `[amount: i128]`
 * as plaintext data (`resources/stellar-contracts/packages/tokens/src/
 * confidential/storage.rs:483-486`), and withdraw is the same boundary in
 * reverse. This is correct and unavoidable — the amount entering or leaving
 * the confidential pool has to reconcile against a public token balance — but
 * a user who sees their deposit amount on a block explorer and concludes the
 * privacy is broken has been failed by the interface, not the protocol.
 */
import { useState, type FormEvent } from "react";

import { useCt } from "../providers/CtProvider.js";
import { xlmToStroops } from "../lib/format.js";

export type MoveMode = "deposit" | "withdraw";

const COPY: Record<MoveMode, { label: string; action: string; working: string }> = {
  deposit: {
    label: "Amount to deposit",
    action: "Deposit",
    working: "Depositing…",
  },
  withdraw: {
    label: "Amount to withdraw",
    action: "Withdraw",
    working: "Proving in your browser… about 10 seconds",
  },
};

export default function MoveFunds({ mode }: { mode: MoveMode }) {
  const { rail, refresh } = useCt();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const copy = COPY[mode];

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!rail || busy) return;
    setError(undefined);

    let stroops: bigint;
    try {
      stroops = xlmToStroops(amount);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setBusy(true);
    try {
      await (mode === "deposit" ? rail.deposit(stroops) : rail.withdraw(stroops));
      setAmount("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!rail) return <p className="muted">Loading confidential wallet…</p>;

  return (
    <>
      <p className="legend legend-exposed">
        <span className="dot dot-exposed" />
        <span>
          <b>This amount is published on chain.</b>{" "}
          {mode === "deposit"
            ? "Moving money into the confidential balance is a public event — what stays private is every transfer you make afterwards."
            : "Taking money back out is a public event, for the same reason a deposit is."}
        </span>
      </p>

      <form
        className="stack"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <label htmlFor={`${mode}Amount`}>{copy.label}</label>
        <input
          id={`${mode}Amount`}
          inputMode="decimal"
          placeholder="0.0000000"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          className={busy ? "btn-working" : undefined}
          disabled={busy || !amount}
        >
          <span>{busy ? copy.working : copy.action}</span>
        </button>
      </form>

      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </>
  );
}
