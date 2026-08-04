/**
 * Public, pool-level statistics for the yield-bearing shielded pool.
 *
 * Every number here is aggregate, on-chain-public information — nothing is
 * per-user (individual note amounts are sealed inside commitments and cannot
 * be read by anyone, including this app). The reads are plain read-only
 * simulations against the pool's own view functions
 * (`contracts/pool-yield/src/pool.rs`: `get_liabilities`, `get_surplus`,
 * `get_invest_params`), the native SAC's `balance`, and the DeFindex vault's
 * `balance` / `get_asset_amounts_per_shares`.
 *
 * Standalone on purpose: imports only `@stellar/stellar-sdk` + shared config,
 * so the SPP page can use it without touching the CT rail's module graph
 * (same import-hygiene rule as `lib/relayer-errors.ts` — see
 * `docs/modules/app.md`).
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { TESTNET } from "@privacy-wallet/shared";

/** Fee-source placeholder for read-only simulations (never signs, never submits). */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** One read-only contract call, returning the raw result `ScVal`. */
export type SimulateFn = (contractId: string, method: string, args: xdr.ScVal[]) => Promise<xdr.ScVal>;

export interface PoolStats {
  /** Note-backed stroops the pool owes depositors (Σ shields − Σ unshields). */
  liabilities: bigint;
  /** Stroops sitting idle in the pool contract, ready for instant withdrawals. */
  idle: bigint;
  /** The pool's DeFindex vault shares. */
  vaultShares: bigint;
  /** What those shares are currently worth, in stroops. */
  vaultValue: bigint;
  /** Accrued yield: (idle + vaultValue) − liabilities, clamped ≥ 0 — the only amount the operator can collect. */
  surplus: bigint;
  /** Idle level (stroops) that triggers a batched invest into the vault. */
  investThreshold: bigint;
  /** Idle stroops kept out of the vault so withdrawals rarely need a divest. */
  liquidityBuffer: bigint;
}

function makeSimulate(): SimulateFn {
  const server = new rpc.Server(TESTNET.rpcUrl);
  return async (contractId, method, args) => {
    const account = await server
      .getAccount(NULL_ACCOUNT)
      .catch(() => new Account(NULL_ACCOUNT, "0"));
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate ${method} failed: ${sim.error}`);
    }
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) throw new Error(`simulate ${method}: no result`);
    return retval;
  };
}

/**
 * Fetch the pool's public stats. `simulate` is injectable for tests; the
 * default builds a fresh RPC-backed simulator per call (stats are read
 * rarely — no connection worth pooling).
 */
export async function fetchPoolStats(simulate: SimulateFn = makeSimulate()): Promise<PoolStats> {
  const pool = new Address(TESTNET.spp.pool).toScVal();
  const [liabilities, surplus, investParams, idle, vaultShares] = await Promise.all([
    simulate(TESTNET.spp.pool, "get_liabilities", []).then((v) => scValToNative(v) as bigint),
    simulate(TESTNET.spp.pool, "get_surplus", []).then((v) => scValToNative(v) as bigint),
    simulate(TESTNET.spp.pool, "get_invest_params", []).then(
      (v) => scValToNative(v) as [bigint, bigint]
    ),
    simulate(TESTNET.nativeSac, "balance", [pool]).then((v) => scValToNative(v) as bigint),
    simulate(TESTNET.spp.defindexVault, "balance", [pool]).then((v) => scValToNative(v) as bigint),
  ]);

  // Valuing 0 shares would be a wasted round-trip (and DeFindex's math assumes > 0).
  const vaultValue =
    vaultShares > 0n
      ? await simulate(TESTNET.spp.defindexVault, "get_asset_amounts_per_shares", [
          nativeToScVal(vaultShares, { type: "i128" }),
        ]).then((v) => (scValToNative(v) as bigint[])[0] ?? 0n)
      : 0n;

  const [investThreshold, liquidityBuffer] = investParams;
  return { liabilities, idle, vaultShares, vaultValue, surplus, investThreshold, liquidityBuffer };
}
