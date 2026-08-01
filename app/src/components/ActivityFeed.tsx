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

interface ActivityApiRow {
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

  useEffect(() => {
    if (row.type !== "transfer") return;
    let cancelled = false;
    (async () => {
      const event = await rail.resolveActivityEvent(row);
      if (cancelled) return;
      if (!event || event.type !== "transfer") {
        setDecrypting(false);
        return;
      }
      setDirection(event.to === rail.address ? "in" : "out");
      const value = await rail.decryptTransferAmount(event);
      if (cancelled) return;
      setAmount(value !== null ? stroopsToXlm(value) : undefined);
      setDecrypting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [row, rail]);

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
        <span>{amountLabel}</span>
        <span className="muted" title={row.txHash}>
          {truncateHash(row.txHash)}
        </span>
      </div>
    </li>
  );
}
