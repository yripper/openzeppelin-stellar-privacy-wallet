/**
 * The Shielded (SPP) rail's whole UI, in one tab.
 *
 * One surface, one identity: the wallet's own `C…` smart account is the pool
 * sender, the registry owner, and the withdraw recipient (the forked SDK —
 * `vendor/stellar-private-payments` — made that possible; `spp.ts`'s module
 * doc has the seams). Shield pulls straight from the wallet's public XLM,
 * unshield pays straight back to it, and recipients are addressed by their
 * wallet `C…` address. No session account, no staging steps.
 *
 * Connection state lives here rather than in a provider (unlike the CT rail's
 * `CtProvider`) because `spp.ts` already memoizes the rail page-wide — one
 * consumer, no context needed.
 */
import { useCallback, useEffect, useReducer, useState, type FormEvent } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { TESTNET } from "@privacy-wallet/shared";

import { useWallet } from "../providers/WalletProvider.js";
import Amount from "../components/Amount.js";
import TxLink from "../components/TxLink.js";
import { stroopsToXlm, truncateAddress, xlmToStroops } from "../lib/format.js";
import { humanizeRelayerError } from "../lib/relayer-errors.js";
import { recordSppBoundaryEvent } from "../lib/spp-boundary-log.js";
import {
  connectSppRail,
  SPP_BOOTNODE_URL,
  SPP_CONNECT_PHASE_LABELS,
  SPP_PROGRESS_EVENT,
  SppWalletSwitchError,
  type SppConnectPhase,
  type SppExecuteResult,
  type SppProgressDetail,
  type SppRail,
  type SppView,
} from "../lib/spp.js";

type Action = "shield" | "send" | "unshield" | "register";

/** User-facing name per action — error copy must never leak the internal key (`"send failed: …"`). */
const ACTION_LABELS: Record<Action, string> = {
  shield: "Shielding",
  send: "Shielded send",
  unshield: "Unshielding",
  register: "Enabling receiving",
};

/** `hashes` are rendered after `text` as stellar.expert links (`TxLink`), so the copy should not also spell them out inline. */
type Notice = { kind: "ok" | "warn" | "error"; text: string; hashes?: string[] };

type RecipientStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; address: string }
  | { kind: "unregistered"; synced: boolean }
  | { kind: "not-contract" }
  | { kind: "invalid" };

/**
 * Human-readable messages for the shielded pool contract's own error codes.
 *
 * Soroban surfaces a failed simulation/submission as a `HostError` string
 * carrying `Error(Contract, #N)` — the SAME convention `@ctd/sdk`'s
 * `humanizeContractError` decodes for the CT contract, deliberately NOT
 * reused here: importing `@ctd/sdk` (even just that one function) pulls its
 * bb.js/UltraHonk proving graph into the SPP tab's bundle
 * (`docs/modules/app.md`'s Task 11 vite gotchas, and `errors.ts`'s own module
 * doc), so this file duplicates the small regex instead of sharing it
 * cross-rail.
 *
 * Codes mirror the deployed pool contract's error enum, verified against the
 * REFERENCE source only —
 * `resources/stellar-private-payments/contracts/pool/src/pool.rs:32-61`, not
 * part of this repo's buildable tree, same "scratch reference" status as
 * `resources/stellar-confidential-token-demo/` (see `docs/modules/ctd-sdk.md`'s
 * "Vendoring" section). Covers the `pool` contract only (shield/send/unshield
 * go through it); the asp-membership/asp-non-membership/registry contracts'
 * own error enums are NOT covered here — a documented gap, not a silent one.
 */
const SPP_POOL_ERRORS: Readonly<Record<number, string>> = {
  1: "Not authorized to perform this shielded operation.",
  2: "The shielded pool's note tree is full — no more shielded transactions can be accepted right now.",
  3: "The shielded pool is already initialized.",
  4: "Invalid pool configuration.",
  5: "Internal pool error (bad note-tree index).",
  // Also the deposit-ceiling rejection (`pool.rs:525-529` returns
  // `WrongExtAmount` when `ext_amount > maximum_deposit_amount`), which is by
  // far the likeliest way a user meets this code — hence naming the cap here
  // rather than only saying "invalid".
  6: "Invalid amount for this pool — a single deposit cannot exceed the pool's maximum (1000 XLM on this deployment).",
  7: "The zero-knowledge proof for this transaction was rejected.",
  8: "This transaction was built against an outdated pool state — try again after a refresh.",
  9: "This note has already been spent (double-spend rejected).",
  10: "This transaction's external data does not match what was proven — try again.",
  11: "The shielded pool is not initialized.",
  12: "Arithmetic overflow while processing this transaction.",
  13: "Invalid proof input.",
  14: "Unsupported policy configuration.",
  // Codes 15-16 are specific to our yield fork (`contracts/pool-yield/src/pool.rs`)
  // and don't exist in the upstream reference the rest of this table was
  // verified against — see `docs/modules/pool-yield.md`.
  //
  // Admin-only misconfiguration, rejected by `__constructor`/
  // `update_invest_params` (`pool.rs:319,1113`) — users essentially never see
  // this code.
  15: "The pool's invest parameters are invalid — contact the operator.",
  // User-reachable on Withdraw: `ensure_idle` (`pool.rs:870-923`) couldn't
  // divest enough from the DeFindex vault to cover the payout, so the
  // withdrawal is refused rather than paid short (never paid short — see
  // `docs/modules/pool-yield.md`'s "Invest failures are swallowed; divest
  // failures are fatal" gotcha).
  16: "The pool could not free enough liquidity from its yield vault to pay this withdrawal. Nothing was paid out — try again in a moment.",
};

const SPP_CONTRACT_CODE_RE = /Error\(Contract,\s*#(\d+)\)/;

/**
 * Humanize a raw SPP failure message: first the pool contract's own table
 * above, then the relayer table (every pool write is assembled and submitted
 * through `kit`/the relayer via the signer's `executeTransaction`, same as
 * the CT rail — see `relayer-errors.ts`'s module doc), else the original text
 * unchanged (the SDK's `pool_err_message` already does some of its own
 * humanizing for non-contract failures, e.g. ASP-sync messages).
 */
export function humanizeSppError(raw: string): string {
  const trimmed = raw.trim();
  const codeMatch = SPP_CONTRACT_CODE_RE.exec(trimmed);
  if (codeMatch) {
    const known = SPP_POOL_ERRORS[Number(codeMatch[1])];
    if (known) return known;
  }
  return humanizeRelayerError(trimmed) ?? trimmed;
}

/**
 * Turn the SDK's execute envelope (`{status:"ok"|"failed"|"aspNotReady"}`,
 * which RESOLVES on failure rather than throwing) into user-facing copy.
 */
export function describeResult(result: SppExecuteResult, label: string): Notice {
  if (result.status === "aspNotReady") {
    return {
      kind: "warn",
      text:
        `${label} can't go through yet: this shielded account isn't approved by the pool's ` +
        `association-set provider (ASP). Approval happens off-chain — try again in a few minutes.`,
    };
  }
  if (result.status === "failed") {
    // SEP-0043 -4: the wallet/signer declined to sign — not a contract or
    // network failure, so it gets its own copy rather than the pool-error
    // table (`code`'s doc: `sdk/web/src/client/execute/mod.rs`'s
    // `ExecuteJsResponse::Failed.code`, "present when the failure was a
    // wallet user rejection").
    if (result.code === -4) {
      return { kind: "warn", text: `${label} was canceled before it could be signed.` };
    }
    const submitted = result.hashes.length
      ? ` — ${result.hashes.length} transaction(s) already submitted:`
      : "";
    return {
      kind: "error",
      text: `${label} failed: ${humanizeSppError(result.message)}${submitted}`,
      hashes: result.hashes,
    };
  }
  const last = result.hashes[result.hashes.length - 1];
  return {
    kind: "ok",
    text: `${label} confirmed in ${result.hashes.length} transaction(s)${last ? " —" : "."}`,
    hashes: last ? [last] : undefined,
  };
}

function errorNotice(error: unknown, label: string): Notice {
  const raw = error instanceof Error ? error.message : String(error);
  return { kind: "error", text: `${label} failed: ${humanizeSppError(raw)}` };
}

/**
 * Decide what an action reports once its post-action re-read has also run.
 *
 * The invariant, extracted here so it is unit-testable: **an action's own
 * outcome is never replaced by a refresh failure.** `refresh()` starts with
 * `client.sync()`, so a transient network hiccup after a successful shield
 * would otherwise swap "Shielding 10 XLM confirmed…" — or the `aspNotReady`
 * explanation — for a state-read error, hiding what just happened to the user's
 * money. A refresh failure is reported alongside it as a staleness warning, and
 * only takes the notice slot when the action produced nothing to say.
 */
export function resolveNotices(
  outcome: Notice | undefined,
  refreshFailure: string | undefined
): { notice: Notice | undefined; staleWarning: string | undefined } {
  if (outcome) return { notice: outcome, staleWarning: refreshFailure };
  if (refreshFailure) {
    return {
      notice: { kind: "error", text: `Reading shielded state failed: ${refreshFailure}` },
      staleWarning: undefined,
    };
  }
  return { notice: undefined, staleWarning: undefined };
}

/** Everything the connect effect owns, as one value — see {@link connectReducer}. */
export interface ConnectState {
  rail: SppRail | undefined;
  phase: SppConnectPhase;
  error: string | undefined;
  /** The failure was specifically "this page already holds another wallet's rail". */
  needsReload: boolean;
}

export type ConnectEvent =
  | { type: "attempt" }
  | { type: "phase"; phase: SppConnectPhase }
  | { type: "connected"; rail: SppRail }
  | { type: "failed"; error: unknown };

export const initialConnectState: ConnectState = {
  rail: undefined,
  phase: "loading-sdk",
  error: undefined,
  needsReload: false,
};

/**
 * Connect-state transitions, as a reducer so the LIFECYCLE is unit-testable
 * without a component-render harness (this repo has none).
 *
 * The rule that earns it: **failure state is scoped to one attempt.** As four
 * independent `useState`s, `error`/`needsReload` were written only in the
 * effect's failure path and never cleared, so the "Reload to switch" gate
 * outlived its cause — connect wallet A, switch to B (rejected with
 * `SppWalletSwitchError`), reconnect A (succeeds, real rail in hand), and the
 * render gate still blocked a perfectly functional tab. `attempt` therefore
 * clears both, and `connected` clears them again on the way in.
 *
 * `attempt` deliberately KEEPS `rail`: a re-run for the same wallet resolves
 * from `connectSppRail`'s memo to the same instance, and blanking it would
 * flash the whole tab back to its loading state for nothing.
 */
export function connectReducer(state: ConnectState, event: ConnectEvent): ConnectState {
  switch (event.type) {
    case "attempt":
      return { ...state, error: undefined, needsReload: false };
    case "phase":
      return { ...state, phase: event.phase };
    case "connected":
      return { ...state, rail: event.rail, error: undefined, needsReload: false };
    case "failed":
      return {
        ...state,
        error: event.error instanceof Error ? event.error.message : String(event.error),
        needsReload: event.error instanceof SppWalletSwitchError,
      };
  }
}

const SPP_PANELS = ["Add funds", "Send", "Withdraw"] as const;
type SppPanel = (typeof SPP_PANELS)[number];

export default function Shielded() {
  const { contractId, bundle } = useWallet();

  const [connect, dispatchConnect] = useReducer(connectReducer, initialConnectState);
  const { rail, phase: connectPhase, error: connectError, needsReload } = connect;
  const [view, setView] = useState<SppView | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  const [busy, setBusy] = useState<Action | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  /** Set when the post-action re-read failed: the action's own outcome stands, but the numbers below it don't. */
  const [staleWarning, setStaleWarning] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<string | undefined>(undefined);

  const [shieldAmount, setShieldAmount] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [unshieldAmount, setUnshieldAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [recipientStatus, setRecipientStatus] = useState<RecipientStatus>({ kind: "idle" });
  /** Which of the three mutually-exclusive action panels is open — same segmented pattern as the CT rail (`pages/Confidential.tsx`). */
  const [panel, setPanel] = useState<SppPanel>("Send");

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
    // Clears any previous attempt's failure state, so a stale "Reload to
    // switch" gate can never survive a fresh (and possibly succeeding) connect.
    dispatchConnect({ type: "attempt" });
    connectSppRail(bundle.sppRootSecret, contractId, {
      onPhase: (phase) => {
        if (!cancelled) dispatchConnect({ type: "phase", phase });
      },
    })
      .then((connected) => {
        if (!cancelled) dispatchConnect({ type: "connected", rail: connected });
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatchConnect({ type: "failed", error });
      });
    return () => {
      cancelled = true;
    };
  }, [contractId, bundle]);

  /**
   * Re-read the shielded snapshot.
   *
   * Reports failure by RETURN VALUE rather than by setting `notice` itself:
   * `run()` calls this after every action, and `refresh()` starts with
   * `client.sync()` (the most failure-prone call in the rail). If it owned the
   * notice, a transient sync hiccup would overwrite the action's own outcome —
   * replacing "Shielding 10 XLM confirmed…", or the ASP-not-ready explanation,
   * with a state-read error, i.e. losing the result of an operation that may
   * have just moved money.
   *
   * @returns a message when the snapshot could not be re-read, `undefined` on success.
   */
  const refresh = useCallback(async (): Promise<string | undefined> => {
    if (!rail) return undefined;
    setRefreshing(true);
    try {
      setView(await rail.refresh());
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      setRefreshing(false);
    }
  }, [rail]);

  /** `refresh()` for the standalone button / mount effect, where the failure IS the only news. */
  const refreshAndReport = useCallback(async (): Promise<void> => {
    const failure = await refresh();
    setStaleWarning(failure);
    if (failure) setNotice({ kind: "error", text: `Reading shielded state failed: ${failure}` });
  }, [refresh]);

  useEffect(() => {
    void refreshAndReport();
  }, [refreshAndReport]);

  async function run(action: Action, fn: () => Promise<Notice | undefined>): Promise<void> {
    setBusy(action);
    setNotice(undefined);
    setStaleWarning(undefined);

    let outcome: Notice | undefined;
    try {
      outcome = await fn();
    } catch (error) {
      outcome = errorNotice(error, ACTION_LABELS[action]);
    } finally {
      setBusy(undefined);
      setProgress(undefined);
    }

    const resolved = resolveNotices(outcome, await refresh());
    setNotice(resolved.notice);
    setStaleWarning(resolved.staleWarning);
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

  /**
   * The pool caps a single deposit at `TESTNET.spp.maxDepositStroops`
   * (`pool.rs:525-529`, `Error::WrongExtAmount`). Catching it here matters
   * because the alternative is ~10 seconds of Groth16 proving in the browser
   * before the contract rejects it — and the raw error, "Invalid transfer
   * amount", says nothing about a ceiling.
   */
  function parseShieldAmount(input: string): bigint | undefined {
    const stroops = parseAmount(input, "Shield");
    if (stroops === undefined) return undefined;
    if (stroops > TESTNET.spp.maxDepositStroops) {
      setNotice({
        kind: "error",
        text:
          `The pool accepts at most ${stroopsToXlm(TESTNET.spp.maxDepositStroops)} XLM per ` +
          `shield — that ceiling is set in the deployed pool, not by this wallet. Shield ` +
          `${stroopsToXlm(TESTNET.spp.maxDepositStroops)} XLM or less; you can repeat it as ` +
          `many times as you like, and your shielded balance adds up across deposits.`,
      });
      return undefined;
    }
    return stroops;
  }

  async function checkRecipient(address: string): Promise<void> {
    const trimmed = address.trim();
    if (!trimmed) return setRecipientStatus({ kind: "idle" });
    // Recipients are wallet C-addresses now (the registry owner the forked SDK
    // registers). A G-address is most likely a leftover session address from
    // the pre-fork flow — it gets its own message rather than a generic
    // "invalid".
    if (StrKey.isValidEd25519PublicKey(trimmed)) return setRecipientStatus({ kind: "not-contract" });
    if (!StrKey.isValidContract(trimmed)) return setRecipientStatus({ kind: "invalid" });
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

  if (needsReload) {
    return (
      <section className="balance-card">
        <h2>Shielded balance</h2>
        <p role="alert" className="error">
          This page is still holding the previous wallet&apos;s shielded session. Reload to switch.
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
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
        <div className="card-header">
          <h2>Shielded balance</h2>
          <button
            type="button"
            className="btn-ghost btn-small"
            onClick={() => void refreshAndReport()}
            disabled={refreshing || disabled}
          >
            {refreshing ? "Reading…" : "Refresh"}
          </button>
        </div>

        <details className="info-tip">
          <summary>How shielded payments work</summary>
          <p className="muted">
            Your wallet itself is the pool identity: shielding pulls XLM straight out of your
            wallet&apos;s public balance (your passkey authorizes it), and unshielding pays straight
            back. Anyone sending you a shielded payment addresses your wallet address below. This
            runs on our fork of the pool SDK — the deployed contracts accept any address; only the
            stock SDK insisted on a separate Ed25519 account. A key derived from your encrypted
            backup still unlocks the pool&apos;s private notes, so restoring the backup restores the
            balance.
          </p>
          <p className="muted">
            Your pool balance is a set of <strong>notes</strong> — private UTXOs. They have no fixed
            denominations: each shield creates one note worth exactly what you shielded, and
            spending one produces a change note. A single shield is capped at{" "}
            {stroopsToXlm(TESTNET.spp.maxDepositStroops)} XLM by the deployed pool, but you can
            shield repeatedly and the balance adds up. A payment proof consumes at most two notes at
            a time, so a balance spread across many small notes is spent as a short chain of
            transactions rather than one.
          </p>
          <dl className="details">
            <dt>Your shielded address</dt>
            <dd>{rail.walletAddress}</dd>
            <dt>Pool</dt>
            <dd>{TESTNET.spp.pool}</dd>
            <dt>History source</dt>
            <dd>{SPP_BOOTNODE_URL}</dd>
          </dl>
        </details>

        {view ? (
          <>
            <div className="cells">
              <div className="cell redacted">
                <div className="cell-label">
                  <span className="dot dot-veil" /> In the pool
                </div>
                <Amount stroops={view.shielded} reveal="decrypted" />
                <p className="cell-note">
                  Held as {view.unspentNotes} unspent {view.unspentNotes === 1 ? "note" : "notes"}.
                  No account of yours holds this on chain.
                  {view.shielded === view.portfolioShielded ? "" : " ⚠︎ portfolio mismatch"}
                </p>
              </div>

              <div className="cell">
                <div className="cell-label">
                  <span className="dot dot-exposed" /> Receiving
                </div>
                <span className="amount">{view.registered ? "On" : "Off"}</span>
                <p className="cell-note">
                  {view.registered
                    ? "Your keys are published — others can send you shielded payments."
                    : "Others cannot send to you yet — enable receiving under Send."}
                </p>
              </div>
            </div>
          </>
        ) : (
          <p className="muted">{refreshing ? "Reading shielded state…" : "No state yet."}</p>
        )}

        {progress ? <p className="muted">{progress}</p> : null}
        {notice ? (
          <p role="alert" className={notice.kind === "error" ? "error" : "muted"}>
            {notice.text}
            {notice.hashes?.map((hash, index) => (
              <span key={hash}>
                {index > 0 ? "," : ""} <TxLink hash={hash} />
              </span>
            ))}
          </p>
        ) : null}
        {staleWarning ? (
          <p role="alert" className="error">
            The balances above could not be refreshed afterwards ({staleWarning}) — they may be out
            of date. Try Refresh.
          </p>
        ) : null}

      </section>

      <section className="send-form">
        <div className="seg" role="group" aria-label="Shielded pool actions">
          {SPP_PANELS.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={name === panel}
              onClick={() => setPanel(name)}
            >
              {name}
            </button>
          ))}
        </div>

        {panel === "Add funds" ? (
          <>
            <p className="legend legend-exposed">
              <span className="dot dot-exposed" />
              <span>
                <b>This step is public.</b> Shielding publishes that your wallet put this amount
                into the pool — what stays private is everything you do inside the pool afterwards.
              </span>
            </p>

            <form
          className="stack"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const stroops = parseShieldAmount(shieldAmount);
            if (stroops === undefined) return;
            void run("shield", async () => {
              const result = await rail.shield(stroops);
              if (result.status === "ok") {
                setShieldAmount("");
                // A shield is a public boundary event (public XLM -> pool) —
                // recorded for the unified Activity view. See
                // `spp-boundary-log.ts`'s module doc for why this can't be
                // read back from chain/SDK state instead.
                await recordSppBoundaryEvent(rail.walletAddress, {
                  type: "shield",
                  amount: stroops.toString(),
                  hashes: result.hashes,
                });
              }
              return describeResult(result, `Shielding ${stroopsToXlm(stroops)} XLM`);
            });
          }}
        >
          <label htmlFor="sppShieldAmount">
            Shield XLM from your wallet into the pool (max{" "}
            {stroopsToXlm(TESTNET.spp.maxDepositStroops)} XLM per deposit, repeatable)
          </label>
          <input
            id="sppShieldAmount"
            inputMode="decimal"
            placeholder="0.0000000"
            value={shieldAmount}
            onChange={(event) => setShieldAmount(event.target.value)}
            disabled={disabled}
          />
          <button
            type="submit"
            className={busy === "shield" ? "btn-working" : undefined}
            disabled={disabled || !shieldAmount}
          >
            <span>
              {busy === "shield" ? "Proving in your browser… about 10 seconds" : "Shield"}
            </span>
          </button>
            </form>
          </>
        ) : null}

        {panel === "Send" ? (
          <>
            <p className="legend legend-veil">
              <span className="dot dot-veil" />
              <span>
                <b>Nothing about this payment is recorded.</b> Not the amount, not the recipient,
                not that you were involved — the pool publishes only an opaque commitment and a
                nullifier.
              </span>
            </p>

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
                  return { kind: "ok", text: "Receiving enabled —", hashes: [hash] };
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
          <label htmlFor="sppRecipient">Recipient wallet address</label>
          <input
            id="sppRecipient"
            placeholder="C…"
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
          {recipientStatus.kind === "not-contract" ? (
            <p className="muted">
              That&apos;s a classic Stellar account (G…). Shielded payments go to the
              recipient&apos;s wallet address (C…) — the same address they receive confidential
              transfers on.
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
          <button
            type="submit"
            className={busy === "send" ? "btn-working" : undefined}
            disabled={disabled || !sendAmount || !canSend}
          >
            <span>
              {busy === "send" ? "Proving in your browser… about 10 seconds" : "Send shielded"}
            </span>
          </button>
            </form>
          </>
        ) : null}

        {panel === "Withdraw" ? (
          <>
            <p className="legend legend-exposed">
              <span className="dot dot-exposed" />
              <span>
                <b>This amount is published on chain.</b> Taking money out of the pool is the same
                public boundary a shield is, in reverse.
              </span>
            </p>

            <form
          className="stack"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const stroops = parseAmount(unshieldAmount, "Unshield");
            if (stroops === undefined) return;
            void run("unshield", async () => {
              const result = await rail.unshield(stroops);
              if (result.status === "ok") {
                setUnshieldAmount("");
                // The pool -> public-XLM boundary event, same rationale as shield above.
                await recordSppBoundaryEvent(rail.walletAddress, {
                  type: "unshield",
                  amount: stroops.toString(),
                  hashes: result.hashes,
                });
              }
              return describeResult(result, `Unshielding ${stroopsToXlm(stroops)} XLM`);
            });
          }}
        >
          <label htmlFor="sppUnshieldAmount">Unshield back to your wallet&apos;s public XLM</label>
          <input
            id="sppUnshieldAmount"
            inputMode="decimal"
            placeholder="0.0000000"
            value={unshieldAmount}
            onChange={(event) => setUnshieldAmount(event.target.value)}
            disabled={disabled}
          />
          <button
            type="submit"
            className={busy === "unshield" ? "btn-working" : undefined}
            disabled={disabled || !unshieldAmount}
          >
            <span>
              {busy === "unshield" ? "Proving in your browser… about 10 seconds" : "Unshield"}
            </span>
          </button>
            </form>
          </>
        ) : null}
      </section>
    </div>
  );
}
