/**
 * The Shielded (SPP) rail's whole UI, in one tab.
 *
 * Deliberately presents ONE surface — "your shielded balance" — even though
 * three addresses are involved under the hood (smart account → session `G…`
 * account → pool notes). The session-account mechanics are explained in a
 * collapsed info disclosure and nowhere else; the actions are phrased in terms
 * the user cares about (add funds / shield / send / unshield / return to
 * wallet).
 *
 * Connection state lives here rather than in a provider (unlike the CT rail's
 * `CtProvider`) because `spp.ts` already memoizes the rail page-wide — one
 * consumer, no context needed.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { TESTNET } from "@grantfox/shared";

import { useWallet } from "../providers/WalletProvider.js";
import { stroopsToXlm, truncateAddress, truncateHash, xlmToStroops } from "../lib/format.js";
import {
  connectSppRail,
  SPP_BOOTNODE_URL,
  SPP_CONNECT_PHASE_LABELS,
  SPP_PROGRESS_EVENT,
  type SppConnectPhase,
  type SppExecuteResult,
  type SppProgressDetail,
  type SppRail,
  type SppView,
} from "../lib/spp.js";

type Action = "create-session" | "fund" | "shield" | "send" | "unshield" | "sweep" | "register";

type Notice = { kind: "ok" | "warn" | "error"; text: string };

type RecipientStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; address: string }
  | { kind: "unregistered"; synced: boolean }
  | { kind: "not-g-address" }
  | { kind: "invalid" };

/**
 * Turn the SDK's execute envelope (`{status:"ok"|"failed"|"aspNotReady"}`,
 * which RESOLVES on failure rather than throwing) into user-facing copy.
 */
function describeResult(result: SppExecuteResult, label: string): Notice {
  if (result.status === "aspNotReady") {
    return {
      kind: "warn",
      text:
        `${label} can't go through yet: this shielded account isn't approved by the pool's ` +
        `association-set provider (ASP). Approval happens off-chain — try again in a few minutes.`,
    };
  }
  if (result.status === "failed") {
    const submitted = result.hashes.length
      ? ` (${result.hashes.length} transaction(s) already submitted: ${result.hashes
          .map(truncateHash)
          .join(", ")})`
      : "";
    return { kind: "error", text: `${label} failed: ${result.message}${submitted}` };
  }
  const last = result.hashes[result.hashes.length - 1];
  return {
    kind: "ok",
    text: `${label} confirmed in ${result.hashes.length} transaction(s)${
      last ? ` — ${truncateHash(last)}` : ""
    }.`,
  };
}

function errorNotice(error: unknown, label: string): Notice {
  return { kind: "error", text: `${label} failed: ${error instanceof Error ? error.message : String(error)}` };
}

export default function Shielded() {
  const { contractId, bundle } = useWallet();

  const [rail, setRail] = useState<SppRail | undefined>(undefined);
  const [connectPhase, setConnectPhase] = useState<SppConnectPhase>("loading-sdk");
  const [connectError, setConnectError] = useState<string | undefined>(undefined);
  const [view, setView] = useState<SppView | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  const [busy, setBusy] = useState<Action | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [progress, setProgress] = useState<string | undefined>(undefined);

  const [fundAmount, setFundAmount] = useState("");
  const [shieldAmount, setShieldAmount] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [unshieldAmount, setUnshieldAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [recipientStatus, setRecipientStatus] = useState<RecipientStatus>({ kind: "idle" });

  // The SDK reports prove/simulate/sign/submit progress as a window
  // CustomEvent (`execute/progress.rs`) — the only feedback available during a
  // multi-minute Groth16 proof.
  useEffect(() => {
    function onProgress(event: Event): void {
      const detail = (event as CustomEvent<SppProgressDetail>).detail;
      setProgress(detail?.message);
    }
    window.addEventListener(SPP_PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(SPP_PROGRESS_EVENT, onProgress);
  }, []);

  // No "already connecting" guard here on purpose: `connectSppRail` owns the
  // one-rail-per-session memoization (a second call while the first is in
  // flight returns the SAME promise), so this effect only has to manage its own
  // subscription. An extra guard here is what broke it the first time — under
  // StrictMode's mount/cleanup/mount, the guard suppressed the second (live)
  // subscription while the first one's cleanup had already cancelled it, so the
  // resolved rail was never handed to React at all.
  useEffect(() => {
    if (!contractId || !bundle) return;
    let cancelled = false;
    connectSppRail(bundle.sppRootSecret, contractId, {
      onPhase: (next) => {
        if (!cancelled) setConnectPhase(next);
      },
    })
      .then((connected) => {
        if (!cancelled) setRail(connected);
      })
      .catch((error: unknown) => {
        if (!cancelled) setConnectError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [contractId, bundle]);

  const refresh = useCallback(async () => {
    if (!rail) return;
    setRefreshing(true);
    try {
      setView(await rail.refresh());
    } catch (error) {
      setNotice(errorNotice(error, "Reading shielded state"));
    } finally {
      setRefreshing(false);
    }
  }, [rail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: Action, fn: () => Promise<Notice | undefined>): Promise<void> {
    setBusy(action);
    setNotice(undefined);
    try {
      const result = await fn();
      if (result) setNotice(result);
    } catch (error) {
      setNotice(errorNotice(error, action));
    } finally {
      setBusy(undefined);
      setProgress(undefined);
      await refresh();
    }
  }

  /** Parse an XLM input, surfacing a bad value as a notice instead of throwing into the click handler. */
  function parseAmount(input: string, label: string): bigint | undefined {
    try {
      const stroops = xlmToStroops(input);
      if (stroops <= 0n) throw new Error("Amount must be greater than zero");
      return stroops;
    } catch (error) {
      setNotice(errorNotice(error, label));
      return undefined;
    }
  }

  async function checkRecipient(address: string): Promise<void> {
    const trimmed = address.trim();
    if (!trimmed) return setRecipientStatus({ kind: "idle" });
    if (StrKey.isValidContract(trimmed)) return setRecipientStatus({ kind: "not-g-address" });
    if (!StrKey.isValidEd25519PublicKey(trimmed)) return setRecipientStatus({ kind: "invalid" });
    if (!rail) return;

    setRecipientStatus({ kind: "checking" });
    try {
      const lookup = await rail.lookupRecipient(trimmed);
      setRecipientStatus(
        lookup.entry
          ? { kind: "ready", address: trimmed }
          : { kind: "unregistered", synced: lookup.registryFullySynced }
      );
    } catch {
      setRecipientStatus({ kind: "invalid" });
    }
  }

  if (!contractId || !bundle) {
    return (
      <section className="balance-card">
        <p className="muted">Connect a wallet to use shielded payments.</p>
      </section>
    );
  }

  if (connectError) {
    return (
      <section className="balance-card">
        <h2>Shielded balance</h2>
        <p role="alert" className="error">
          Could not start the shielded wallet: {connectError}
        </p>
        <p className="muted">
          Historical sync runs through {SPP_BOOTNODE_URL} — check that the API server is running.
        </p>
      </section>
    );
  }

  if (!rail) {
    return (
      <section className="balance-card">
        <h2>Shielded balance</h2>
        <p className="muted" data-testid="spp-connect-phase" data-phase={connectPhase}>
          {SPP_CONNECT_PHASE_LABELS[connectPhase]}
        </p>
      </section>
    );
  }

  const canSend = recipientStatus.kind === "ready";
  const disabled = busy !== undefined;

  return (
    <div className="confidential stack">
      <section className="balance-card">
        <h2>Shielded balance</h2>

        <details className="info-tip">
          <summary>How shielded payments work</summary>
          <p className="muted">
            The shielded pool signs with an Ed25519 key, so your wallet runs it through a dedicated{" "}
            <strong>session account</strong> derived from your privacy bundle (the same backup file
            restores it). Funds move: wallet → session account → shielded pool, and back the same
            way. Anyone sending you a shielded payment sends to your session address below.
          </p>
          <dl className="details">
            <dt>Session address</dt>
            <dd>{rail.sessionAddress}</dd>
            <dt>Pool</dt>
            <dd>{TESTNET.spp.pool}</dd>
            <dt>History source</dt>
            <dd>{SPP_BOOTNODE_URL}</dd>
          </dl>
        </details>

        {view ? (
          <dl className="details">
            <dt>Shielded</dt>
            <dd>
              {stroopsToXlm(view.shielded)} XLM
              {view.shielded === view.portfolioShielded ? "" : " ⚠︎ portfolio mismatch"}
            </dd>
            <dt>Unspent notes</dt>
            <dd>{view.unspentNotes}</dd>
            <dt>Session balance</dt>
            <dd>
              {view.sessionExists ? `${stroopsToXlm(view.sessionXlm)} XLM` : "not created yet"}
            </dd>
            <dt>Receiving</dt>
            <dd>{view.registered ? "enabled" : "not enabled"}</dd>
          </dl>
        ) : (
          <p className="muted">{refreshing ? "Reading shielded state…" : "No state yet."}</p>
        )}

        {progress ? <p className="muted">{progress}</p> : null}
        {notice ? (
          <p role="alert" className={notice.kind === "error" ? "error" : "muted"}>
            {notice.text}
          </p>
        ) : null}

        <button type="button" onClick={() => void refresh()} disabled={refreshing || disabled}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      <section className="send-form">
        <h2>Add funds</h2>

        {view && !view.sessionExists ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              void run("create-session", async () => {
                await rail.fundSessionFromFriendbot();
                return { kind: "ok", text: "Session account created and funded by friendbot." };
              })
            }
          >
            {busy === "create-session" ? "Creating…" : "Create shielded session account"}
          </button>
        ) : null}

        <form
          className="stack"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const stroops = parseAmount(fundAmount, "Move to shielded signer");
            if (stroops === undefined) return;
            void run("fund", async () => {
              const hash = await rail.moveToSession(stroops);
              setFundAmount("");
              return {
                kind: "ok",
                text: `Moved ${stroopsToXlm(stroops)} XLM to the shielded signer — ${truncateHash(hash)}.`,
              };
            });
          }}
        >
          <label htmlFor="sppFundAmount">Move public XLM from your wallet into the shielded signer</label>
          <input
            id="sppFundAmount"
            inputMode="decimal"
            placeholder="0.0000000"
            value={fundAmount}
            onChange={(event) => setFundAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="submit" disabled={disabled || !fundAmount}>
            {busy === "fund" ? "Moving…" : "Move XLM"}
          </button>
        </form>

        <form
          className="stack"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const stroops = parseAmount(shieldAmount, "Shield");
            if (stroops === undefined) return;
            void run("shield", async () => {
              const result = await rail.shield(stroops);
              if (result.status === "ok") setShieldAmount("");
              return describeResult(result, `Shielding ${stroopsToXlm(stroops)} XLM`);
            });
          }}
        >
          <label htmlFor="sppShieldAmount">Shield XLM into the pool</label>
          <input
            id="sppShieldAmount"
            inputMode="decimal"
            placeholder="0.0000000"
            value={shieldAmount}
            onChange={(event) => setShieldAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="submit" disabled={disabled || !shieldAmount}>
            {busy === "shield" ? "Proving + shielding…" : "Shield"}
          </button>
        </form>
      </section>

      <section className="send-form">
        <h2>Send shielded</h2>

        {view && !view.registered ? (
          <div className="stack">
            <p className="muted">
              Publish this wallet&apos;s shielded keys so other people can send to you. Not needed to
              send.
            </p>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void run("register", async () => {
                  const hash = await rail.registerPublicKeys();
                  return { kind: "ok", text: `Receiving enabled — ${truncateHash(hash)}.` };
                })
              }
            >
              {busy === "register" ? "Publishing keys…" : "Enable receiving"}
            </button>
          </div>
        ) : null}

        <form
          className="stack"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const stroops = parseAmount(sendAmount, "Shielded send");
            if (stroops === undefined) return;
            void run("send", async () => {
              const result = await rail.sendShielded(recipient.trim(), stroops);
              if (result.status === "ok") {
                setSendAmount("");
                setRecipient("");
                setRecipientStatus({ kind: "idle" });
              }
              return describeResult(result, `Shielded send of ${stroopsToXlm(stroops)} XLM`);
            });
          }}
        >
          <label htmlFor="sppRecipient">Recipient shielded address</label>
          <input
            id="sppRecipient"
            placeholder="G…"
            value={recipient}
            onChange={(event) => {
              setRecipient(event.target.value);
              setRecipientStatus({ kind: "idle" });
            }}
            onBlur={(event) => void checkRecipient(event.target.value)}
            disabled={disabled}
          />
          {recipientStatus.kind === "checking" ? (
            <p className="muted">Looking the recipient up in the pool registry…</p>
          ) : null}
          {recipientStatus.kind === "ready" ? (
            <p className="muted">Ready to receive shielded payments.</p>
          ) : null}
          {recipientStatus.kind === "unregistered" ? (
            <p className="muted">
              Not registered in the shielded pool
              {recipientStatus.synced
                ? " — ask them to open their Shielded tab and enable receiving."
                : " yet (the local registry is still syncing — try again shortly)."}
            </p>
          ) : null}
          {recipientStatus.kind === "not-g-address" ? (
            <p className="muted">
              That&apos;s a smart-account address (C…). Shielded payments go to the recipient&apos;s
              shielded session address (G…) — you&apos;ll find it under &ldquo;How shielded payments
              work&rdquo; in their wallet.
            </p>
          ) : null}
          {recipientStatus.kind === "invalid" ? (
            <p className="muted">That doesn&apos;t look like a Stellar address.</p>
          ) : null}

          <label htmlFor="sppSendAmount">Amount</label>
          <input
            id="sppSendAmount"
            inputMode="decimal"
            placeholder="0.0000000"
            value={sendAmount}
            onChange={(event) => setSendAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="submit" disabled={disabled || !sendAmount || !canSend}>
            {busy === "send" ? "Proving + sending…" : "Send shielded"}
          </button>
        </form>
      </section>

      <section className="send-form">
        <h2>Take funds out</h2>

        <form
          className="stack"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const stroops = parseAmount(unshieldAmount, "Unshield");
            if (stroops === undefined) return;
            void run("unshield", async () => {
              const result = await rail.unshield(stroops);
              if (result.status === "ok") setUnshieldAmount("");
              return describeResult(result, `Unshielding ${stroopsToXlm(stroops)} XLM`);
            });
          }}
        >
          <label htmlFor="sppUnshieldAmount">Unshield back to public XLM</label>
          <input
            id="sppUnshieldAmount"
            inputMode="decimal"
            placeholder="0.0000000"
            value={unshieldAmount}
            onChange={(event) => setUnshieldAmount(event.target.value)}
            disabled={disabled}
          />
          <button type="submit" disabled={disabled || !unshieldAmount}>
            {busy === "unshield" ? "Proving + unshielding…" : "Unshield"}
          </button>
        </form>

        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void run("sweep", async () => {
              const swept = await rail.sweepToWallet();
              return swept
                ? {
                    kind: "ok",
                    text: `Returned ${stroopsToXlm(swept.amount)} XLM to ${truncateAddress(
                      rail.walletAddress
                    )} — ${truncateHash(swept.hash)}.`,
                  }
                : { kind: "warn", text: "Nothing above the session account's reserve to return." };
            })
          }
        >
          {busy === "sweep" ? "Returning…" : "Return session XLM to wallet"}
        </button>
      </section>
    </div>
  );
}
