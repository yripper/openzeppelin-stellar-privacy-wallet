/**
 * The SPP half of the unified Activity view: this wallet's local log of
 * shield/unshield boundary events (`lib/spp-boundary-log.ts` — see that
 * module's doc for why this is recorded locally rather than read back from
 * chain/SDK state). Deliberately does NOT list shielded transfers — those
 * stay hidden by design, and this component only ever reads what
 * `Shielded.tsx` chose to record.
 *
 * Takes `sessionAddress` directly rather than connecting an `SppRail`, so the
 * unified Activity tab can show this log without paying for the SPP SDK's
 * wasm/worker startup cost — the session address is a pure derivation from
 * the wallet's already-loaded privacy bundle (`spp-signer.ts`'s
 * `sessionKeypair`), not something that requires a live pool connection.
 */
import { useCallback, useEffect, useState } from "react";

import { listSppBoundaryEvents, type SppBoundaryEvent } from "../lib/spp-boundary-log.js";
import { truncateHash } from "../lib/format.js";
import Amount from "./Amount.js";

const TYPE_LABELS: Record<SppBoundaryEvent["type"], string> = {
  shield: "Shield",
  unshield: "Unshield",
};

export default function SppBoundaryFeed({ sessionAddress }: { sessionAddress: string }) {
  const [rows, setRows] = useState<SppBoundaryEvent[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setRows(await listSppBoundaryEvents(sessionAddress));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="activity-feed">
      <div className="activity-feed-header">
        <h2>Shielded pool boundary events</h2>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Reload"}
        </button>
      </div>
      <p className="muted">
        Shield and unshield move money across the public/private line, so they&apos;re recorded here.
        Shielded transfers between pool participants stay hidden — they never appear in this list.
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {loading && !rows ? <p className="muted">Loading…</p> : null}
      {rows && rows.length === 0 ? (
        <div className="empty">
          <p>Nothing has crossed the public line yet. Shield some XLM and it will show up here.</p>
        </div>
      ) : null}
      <ul className="activity-list">
        {rows?.map((row) => (
          <li key={row.id} className="activity-row">
            <div className="activity-row-main">
              <span className="activity-type">{TYPE_LABELS[row.type]}</span>
              <span className="muted">{new Date(row.createdAt).toLocaleString()}</span>
            </div>
            <div className="activity-row-meta">
              <span className="chip chip-exposed">on chain</span>
              <Amount
                stroops={row.type === "unshield" ? -BigInt(row.amount) : BigInt(row.amount)}
                signed
                className="amount-row"
              />
              {row.hashes[0] ? (
                <span className="muted" title={row.hashes[0]}>
                  {truncateHash(row.hashes[0])}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
