/**
 * Public statistics of the yield-bearing shielded pool — the demo-facing view
 * of the pool's balance sheet.
 *
 * Everything shown is aggregate, on-chain-public information (see
 * `lib/pool-stats.ts`): what the pool owes depositors, how its assets split
 * between idle liquidity and the DeFindex vault position, and the accrued
 * yield the operator can collect. Deliberately labeled as pool-level figures —
 * the one thing this card must never imply is that any of it is the viewer's
 * own balance or that users earn the yield (they don't; it is the operator's
 * protocol fee, and per-user yield is impossible while note amounts stay
 * sealed).
 */

import { useCallback, useEffect, useState } from "react";
import { TESTNET } from "@privacy-wallet/shared";
import { fetchPoolStats, type PoolStats as Stats } from "../lib/pool-stats.js";
import { stroopsToXlm } from "../lib/format.js";
import Amount from "./Amount.js";

export default function PoolStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await fetchPoolStats());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="balance-card">
      <div className="card-header">
        <h2>Pool stats</h2>
        <button
          type="button"
          className="btn-ghost btn-small"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>

      <p className="legend legend-exposed">
        <span className="dot dot-exposed" />
        Pool-level figures, public on chain — everyone&apos;s aggregate, not your balance.
      </p>

      {stats ? (
        <>
          <div className="cells">
            <div className="cell">
              <div className="cell-label">Owed to depositors</div>
              <Amount stroops={stats.liabilities} />
              <p className="cell-note">
                Every XLM ever shielded minus every XLM unshielded. The pool can never pay the
                operator out of this.
              </p>
            </div>
            <div className="cell">
              <div className="cell-label">Accrued yield</div>
              <Amount stroops={stats.surplus} />
              <p className="cell-note">
                (idle + vault position) − owed. Collectable by the pool operator as the protocol
                fee for running the privacy service.
              </p>
            </div>
            <div className="cell">
              <div className="cell-label">Idle liquidity</div>
              <Amount stroops={stats.idle} />
              <p className="cell-note">Held in the pool contract for instant withdrawals.</p>
            </div>
            <div className="cell">
              <div className="cell-label">Earning in DeFindex</div>
              <Amount stroops={stats.vaultValue} />
              <p className="cell-note">
                {stroopsToXlm(stats.vaultShares)} vault shares, valued at current share price.
              </p>
            </div>
          </div>
          <p className="muted">
            The pool batch-invests idle funds above {stroopsToXlm(stats.investThreshold)} XLM into
            the DeFindex vault and keeps {stroopsToXlm(stats.liquidityBuffer)} XLM liquid;
            withdrawals larger than the idle balance divest automatically in the same transaction.
          </p>
          <dl className="details">
            <dt>Pool</dt>
            <dd>{TESTNET.spp.pool}</dd>
            <dt>DeFindex vault</dt>
            <dd>{TESTNET.spp.defindexVault}</dd>
          </dl>
        </>
      ) : error ? (
        <p role="alert" className="error">
          Could not read the pool&apos;s public stats ({error}). Try Refresh.
        </p>
      ) : (
        <p className="muted">Reading pool state…</p>
      )}
    </section>
  );
}
