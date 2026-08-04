import { describe, expect, it } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { TESTNET } from "@privacy-wallet/shared";
import { fetchPoolStats, type SimulateFn } from "./pool-stats.js";

/** ScVal-typed canned answers keyed by `<contractId>.<method>`. */
function fakeSimulate(answers: Record<string, xdr.ScVal>): { simulate: SimulateFn; calls: string[] } {
  const calls: string[] = [];
  const simulate: SimulateFn = async (contractId, method) => {
    const key = `${contractId}.${method}`;
    calls.push(key);
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected simulate call: ${key}`);
    return answer;
  };
  return { simulate, calls };
}

const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });

describe("fetchPoolStats", () => {
  it("reads and shapes all pool figures, valuing the vault position", async () => {
    const { simulate } = fakeSimulate({
      [`${TESTNET.spp.pool}.get_liabilities`]: i128(12_000_000_000n),
      [`${TESTNET.spp.pool}.get_surplus`]: i128(17_131n),
      // get_invest_params returns a (i128, i128) tuple — an ScVal vec.
      [`${TESTNET.spp.pool}.get_invest_params`]: xdr.ScVal.scvVec([
        i128(10_000_000_000n),
        i128(2_000_000_000n),
      ]),
      [`${TESTNET.nativeSac}.balance`]: i128(2_000_017_131n),
      [`${TESTNET.spp.defindexVault}.balance`]: i128(9_999_664_616n),
      // Vec<i128> per the vault interface.
      [`${TESTNET.spp.defindexVault}.get_asset_amounts_per_shares`]: xdr.ScVal.scvVec([
        i128(10_000_000_000n),
      ]),
    });

    const stats = await fetchPoolStats(simulate);
    expect(stats).toEqual({
      liabilities: 12_000_000_000n,
      surplus: 17_131n,
      investThreshold: 10_000_000_000n,
      liquidityBuffer: 2_000_000_000n,
      idle: 2_000_017_131n,
      vaultShares: 9_999_664_616n,
      vaultValue: 10_000_000_000n,
    });
  });

  it("skips vault valuation when the pool holds no shares", async () => {
    const { simulate, calls } = fakeSimulate({
      [`${TESTNET.spp.pool}.get_liabilities`]: i128(0n),
      [`${TESTNET.spp.pool}.get_surplus`]: i128(0n),
      [`${TESTNET.spp.pool}.get_invest_params`]: xdr.ScVal.scvVec([
        i128(10_000_000_000n),
        i128(2_000_000_000n),
      ]),
      [`${TESTNET.nativeSac}.balance`]: i128(0n),
      [`${TESTNET.spp.defindexVault}.balance`]: i128(0n),
    });

    const stats = await fetchPoolStats(simulate);
    expect(stats.vaultShares).toBe(0n);
    expect(stats.vaultValue).toBe(0n);
    expect(calls).not.toContain(`${TESTNET.spp.defindexVault}.get_asset_amounts_per_shares`);
  });

  it("propagates a failed read instead of rendering half-true stats", async () => {
    const { simulate } = fakeSimulate({}); // every call unexpected
    await expect(fetchPoolStats(simulate)).rejects.toThrow(/unexpected simulate call/);
  });
});
