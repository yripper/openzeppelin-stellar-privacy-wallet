/**
 * Confidential-Token invoke glue.
 *
 * The `@ctd/sdk` `ChainClient.invoke` path assumes the transaction source is
 * also the sole auth principal, which only holds for G-address signers. Our
 * wallet's holder is a smart-account **C-address**, so the fee payer and the
 * auth principal are different parties and the auth entries have to be signed
 * out-of-band before the transaction is assembled.
 *
 * `buildCtInvokeTx` is the shared seam for both consumers of that split:
 *   - Node (`scripts/smoke-ct.ts`): sign the C-address auth entries manually
 *     with `smart-account-kit`'s `computeEntryAuthDigest` + `Ed25519Signer`.
 *   - Browser (Task 11): hand the returned `AssembledTransaction` straight to
 *     `SmartAccountKit.signAndSubmit`, which reads `built` + `simulationData`.
 *
 * Both need the same thing: a *simulated* `contract.AssembledTransaction`
 * wrapping a single `invokeContractFunction` operation, with the auth entries
 * the host recorded still unsigned.
 */

import { Operation, contract } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";

export interface CtInvokeConfig {
  /** Soroban RPC endpoint (`http://` is only allowed for local nodes). */
  rpcUrl: string;
  networkPassphrase: string;
  /** Fee-paying source account (G-address) the envelope is built for. */
  source: string;
}

/**
 * Build the `invokeHostFunction` operation for `contractId.method(...args)`.
 *
 * Pure and network-free — split out from {@link buildCtInvokeTx} so the
 * argument encoding can be unit-tested without an RPC round-trip.
 */
export function buildCtInvokeOp(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: contractId,
    function: method,
    args,
  });
}

/**
 * Build and simulate an arbitrary confidential-token contract invocation.
 *
 * The returned transaction is simulated but **not** signed and **not**
 * authorized: `tx.simulationData.result.auth` holds the entries the caller
 * still has to sign (a C-address holder needs a smart-account AuthPayload;
 * a G-address holder is covered by the envelope signature). Accessing
 * `simulationData` throws `AssembledTransaction.Errors.SimulationFailed` when
 * the host rejected the call, which is how contract errors surface here.
 *
 * @param cfg - RPC endpoint, network, and the fee-paying source account.
 * @param contractId - Contract to invoke (`C…`).
 * @param method - Contract function name.
 * @param args - Already-encoded arguments, in declaration order.
 */
export async function buildCtInvokeTx(
  cfg: CtInvokeConfig,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<contract.AssembledTransaction<unknown>> {
  return contract.AssembledTransaction.buildWithOp<unknown>(
    buildCtInvokeOp(contractId, method, args),
    {
      contractId,
      method,
      args,
      rpcUrl: cfg.rpcUrl,
      // Mirrors ChainClient's rule: plaintext RPC is opt-in by URL scheme only.
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      networkPassphrase: cfg.networkPassphrase,
      publicKey: cfg.source,
      parseResultXdr: (result: xdr.ScVal): unknown => result,
    },
  );
}
