/**
 * Confidential-token activity feed: `GET /accounts/:address/activity`
 * (`@grantfox/api`'s own newest-first `ct_activity` feed — normalized rows
 * with the raw hex `ciphertexts`, see `docs/modules/api.md`). `deposit`/
 * `withdraw` amounts are public (already plaintext on the row); `transfer`
 * amounts are `null` on the row and decrypted client-side by resolving the
 * row's full on-chain event through `ct.ts`'s XDR-decoding indexer adapter
 * (`rail.resolveActivityEvent`) and decrypting it
 * (`rail.decryptTransferAmount`, both sides — inbound via the wallet's own
 * viewing key, outbound via the sender-side ephemeral-scalar re-derivation).
 */
import { useCallback, useEffect, useState } from "react";

import { useCt } from "../providers/CtProvider.js";
import { API_URL, type CtRail } from "../lib/ct.js";
import { stroopsToXlm, truncateAddress, truncateHash } from "../lib/format.js";

export interface ActivityApiRow {
  id: string;
  account: string;
  type: string;
  counterparty: string;
  amount: string | null;
  ledger: number;
  txHash: string;
  eventId: string;
  ciphertexts: Record<string, string>;
}

const TYPE_LABELS: Record<string, string> = {
  register: "Activated",
  deposit: "Deposit",
  merge: "Merge",
  withdraw: "Withdraw",
  transfer: "Transfer",
};

/** The slice of `CtRail` a transfer-row decrypt needs — narrow on purpose so it's mockable without a real `CtRail` (bb.js provers, StateEngine) in tests. */
export type TransferDecryptRail = Pick<CtRail, "address" | "resolveActivityEvent" | "decryptTransferAmount">;

export interface ResolvedTransfer {
  amount: string | undefined;
  direction: "in" | "out" | undefined;
}

/**
 * Resolve + decrypt one `transfer` activity row's amount, or `null` if the
 * row's on-chain event can't be matched (a legitimate "stays confidential"
 * case, not an error). Extracted from `ActivityRow`'s effect so the
 * network/decrypt failure path is unit-testable without a component
 * render harness — `ActivityRow` is the only caller and owns turning a
 * REJECTION here into the row's error state (see its module doc: this
 * function is deliberately NOT defensive, same "throw, don't swallow"
 * split as `ct-indexer.ts`'s decoders).
 */
export async function resolveTransferAmount(
  row: ActivityApiRow,
  rail: TransferDecryptRail,
): Promise<ResolvedTransfer | null> {
  const event = await rail.resolveActivityEvent(row);
  if (!event || event.type !== "transfer") return null;
  const direction: "in" | "out" = event.to === rail.address ? "in" : "out";
  const value = await rail.decryptTransferAmount(event);
  return { amount: value !== null ? stroopsToXlm(value) : undefined, direction };
}

export default function ActivityFeed() {
  const { rail } = useCt();
  const [rows, setRows] = useState<ActivityApiRow[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!rail) return;
    setLoading(true);
    setError(undefined);
    try {
      const resp = await fetch(`${API_URL}/accounts/${rail.address}/activity`);
      if (!resp.ok) {
        throw new Error(`Activity feed request failed (${resp.status}).`);
      }
      const body = (await resp.json()) as { activity: ActivityApiRow[] };
      setRows(body.activity);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rail]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rail) {
    return (
      <section className="activity-feed">
        <p className="muted">Loading confidential wallet…</p>
      </section>
    );
  }

  return (
    <section className="activity-feed">
      <div className="activity-feed-header">
        <h2>Activity</h2>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Reload"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {rows && rows.length === 0 ? <p className="muted">No activity yet.</p> : null}
      <ul className="activity-list">
        {rows?.map((row) => (
          <ActivityRow key={row.id} row={row} rail={rail} />
        ))}
      </ul>
    </section>
  );
}

function ActivityRow({ row, rail }: { row: ActivityApiRow; rail: CtRail }) {
  const publicAmount = row.amount !== null ? stroopsToXlm(BigInt(row.amount)) : undefined;
  const [amount, setAmount] = useState<string | undefined>(publicAmount);
  const [direction, setDirection] = useState<"in" | "out" | undefined>(undefined);
  const [decrypting, setDecrypting] = useState(row.type === "transfer");
  const [decryptError, setDecryptError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (row.type !== "transfer") return;
    let cancelled = false;
    setDecrypting(true);
    setDecryptError(false);
    resolveTransferAmount(row, rail)
      .then((resolved) => {
        if (cancelled) return;
        if (resolved) {
          setDirection(resolved.direction);
          setAmount(resolved.amount);
        }
        setDecrypting(false);
      })
      .catch(() => {
        // A transient failure (network error resolving the event, or the
        // outbound decrypt path's confidentialBalance simulate call) must
        // not leave this row stuck on "Decrypting…" forever with no way to
        // recover — surface a compact error state with a retry affordance
        // instead of an unhandled rejection.
        if (cancelled) return;
        setDecryptError(true);
        setDecrypting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row, rail, attempt]);

  const sign = direction === "out" ? "-" : direction === "in" ? "+" : "";
  const amountLabel = decrypting ? "Decrypting…" : amount !== undefined ? `${sign}${amount} XLM` : "Private";

  return (
    <li className="activity-row">
      <div className="activity-row-main">
        <span className="activity-type">{TYPE_LABELS[row.type] ?? row.type}</span>
        <span className="muted" title={row.counterparty}>
          {truncateAddress(row.counterparty)}
        </span>
      </div>
      <div className="activity-row-meta">
        {decryptError ? (
          <button type="button" className="retry-inline" onClick={() => setAttempt((a) => a + 1)}>
            Amount unavailable — retry
          </button>
        ) : (
          <span>{amountLabel}</span>
        )}
        <span className="muted" title={row.txHash}>
          {truncateHash(row.txHash)}
        </span>
      </div>
    </li>
  );
}
