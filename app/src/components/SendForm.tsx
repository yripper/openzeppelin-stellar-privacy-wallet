/**
 * Confidential transfer form: recipient address (C… only — every Privacy
 * Wallet account is a smart-account contract address; a pasted G-address gets a
 * dedicated "wrong address kind" message rather than a generic invalid
 * one), a live "is this address registered for confidential transfers?"
 * check on paste/blur (CT contract read via simulation — `rail.isRegistered`),
 * amount, and submit -> `rail.transfer(to, amount)`.
 */
import { useState, type FormEvent } from "react";
import { StrKey } from "@stellar/stellar-sdk";

import { useCt } from "../providers/CtProvider.js";
import { xlmToStroops } from "../lib/format.js";
import TxLink from "./TxLink.js";

type RecipientStatus =
  | "idle"
  | "invalid"
  | "not-contract"
  | "checking"
  | "registered"
  | "unregistered"
  | "check-failed";

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
    // Every Privacy Wallet account is a smart-account C-address — a G-address is
    // never a valid recipient within this app's own user base, even though
    // the CT protocol itself also supports keypair (G-address) holders
    // (`scripts/smoke-ct.ts`'s "bob"). Distinguish the two invalid cases so
    // a pasted G-address gets an actionable message instead of a generic
    // "not a valid address".
    if (StrKey.isValidEd25519PublicKey(trimmed)) {
      setStatus("not-contract");
      return;
    }
    if (!StrKey.isValidContract(trimmed)) {
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
    return <p className="muted">Loading confidential wallet…</p>;
  }

  const blocked = status === "invalid" || status === "not-contract" || status === "unregistered";

  return (
    <>
      <p className="legend legend-veil">
        <span className="dot dot-veil" />
        <span>
          <b>The amount is encrypted.</b> The ledger records that a transfer happened between two
          accounts, never how much.
        </span>
      </p>
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
          placeholder="C…"
          autoComplete="off"
          disabled={busy}
        />
        {status === "checking" ? <p className="muted">Checking…</p> : null}
        {status === "invalid" ? <p className="error">That doesn't look like a Stellar address.</p> : null}
        {status === "not-contract" ? (
          <p className="error">
            That's a Stellar account address (G…), not a wallet's contract address — confidential balances live on
            C… addresses. Ask the recipient for their Privacy Wallet C… address instead.
          </p>
        ) : null}
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

        <button
          type="submit"
          className={busy ? "btn-working" : undefined}
          disabled={busy || !recipient.trim() || !amount || blocked}
        >
          <span>{busy ? "Proving in your browser… about 10 seconds" : "Send"}</span>
        </button>
      </form>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {successHash ? (
        <p className="muted">
          Sent — <TxLink hash={successHash} />
        </p>
      ) : null}
    </>
  );
}
