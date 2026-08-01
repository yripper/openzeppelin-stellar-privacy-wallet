/**
 * Confidential transfer form: recipient address, a live "is this address
 * registered for confidential transfers?" check on paste/blur (CT contract
 * read via simulation — `rail.isRegistered`), amount, and submit ->
 * `rail.transfer(to, amount)`.
 */
import { useState, type FormEvent } from "react";
import { StrKey } from "@stellar/stellar-sdk";

import { useCt } from "../providers/CtProvider.js";
import { truncateHash, xlmToStroops } from "../lib/format.js";

type RecipientStatus = "idle" | "invalid" | "checking" | "registered" | "unregistered" | "check-failed";

function isPlausibleAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}

export default function SendForm() {
  const { rail, refresh } = useCt();
  const [recipient, setRecipient] = useState("");
  const [status, setStatus] = useState<RecipientStatus>("idle");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [successHash, setSuccessHash] = useState<string | undefined>(undefined);

  async function checkRecipient(value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      setStatus("idle");
      return;
    }
    if (!isPlausibleAddress(trimmed)) {
      setStatus("invalid");
      return;
    }
    if (!rail) return;
    setStatus("checking");
    try {
      const registered = await rail.isRegistered(trimmed);
      setStatus(registered ? "registered" : "unregistered");
    } catch {
      setStatus("check-failed");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!rail || busy) return;
    setError(undefined);
    setSuccessHash(undefined);

    let stroops: bigint;
    try {
      stroops = xlmToStroops(amount);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setBusy(true);
    try {
      const hash = await rail.transfer(recipient.trim(), stroops);
      setSuccessHash(hash);
      setAmount("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!rail) {
    return (
      <section className="send-form">
        <p className="muted">Loading confidential wallet…</p>
      </section>
    );
  }

  const blocked = status === "invalid" || status === "unregistered";

  return (
    <section className="send-form">
      <h2>Send confidentially</h2>
      <form
        className="stack"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <label htmlFor="recipient">Recipient address</label>
        <input
          id="recipient"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          onBlur={(event) => void checkRecipient(event.target.value)}
          onPaste={(event) => void checkRecipient(event.clipboardData.getData("text"))}
          placeholder="G… or C…"
          autoComplete="off"
          disabled={busy}
        />
        {status === "checking" ? <p className="muted">Checking…</p> : null}
        {status === "invalid" ? <p className="error">That doesn't look like a Stellar address.</p> : null}
        {status === "check-failed" ? <p className="error">Couldn't check this address right now.</p> : null}
        {status === "unregistered" ? (
          <p className="error">
            This recipient hasn't activated confidential transfers yet — ask them to activate privacy first.
          </p>
        ) : null}
        {status === "registered" ? <p className="muted">Ready to receive confidential transfers.</p> : null}

        <label htmlFor="amount">Amount (XLM)</label>
        <input
          id="amount"
          inputMode="decimal"
          placeholder="0.0000000"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={busy}
        />

        <button type="submit" disabled={busy || !recipient.trim() || !amount || blocked}>
          {busy ? "Proving + sending…" : "Send"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {successHash ? <p className="muted">Sent (tx {truncateHash(successHash)}).</p> : null}
    </section>
  );
}
