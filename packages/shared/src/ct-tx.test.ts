/**
 * Offline tests for the CT invoke glue.
 *
 * No network: the `AssembledTransaction` path is exercised against a stubbed
 * `rpc.Server` (account lookup + simulation), so the assertions cover the real
 * build → simulate → assemble pipeline rather than a re-implementation of it.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { buildCtInvokeOp, buildCtInvokeTx } from "./ct-tx.js";
import { TESTNET } from "./config.js";

const SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TOKEN = TESTNET.ct.token;

/** The `{contract, function, args}` triple recorded inside an invoke op. */
function readInvokeOp(op: xdr.Operation): {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
} {
  const invokeArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
  return {
    contractId: Address.fromScAddress(invokeArgs.contractAddress()).toString(),
    method: invokeArgs.functionName().toString(),
    args: invokeArgs.args(),
  };
}

/** A representative slice of the ScVal shapes the CT entry points take. */
function sampleArgs(): xdr.ScVal[] {
  return [
    new Address(TOKEN).toScVal(),
    new Address(SOURCE).toScVal(),
    xdr.ScVal.scvU32(0),
    nativeToScVal(100_0000000n, { type: "i128" }),
    xdr.ScVal.scvBytes(Buffer.from("deadbeef".repeat(8), "hex")),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("payload"),
        val: xdr.ScVal.scvBytes(Buffer.alloc(64, 7)),
      }),
    ]),
  ];
}

/**
 * Stub the two RPC calls `AssembledTransaction.buildWithOp` makes: the source
 * account lookup and the simulation. The simulation response is pre-parsed
 * (`_parsed: true`) so `assembleTransaction` consumes it verbatim.
 */
function stubRpc(auth: xdr.SorobanAuthorizationEntry[] = []): void {
  vi.spyOn(rpc.Server.prototype, "getAccountEntry").mockResolvedValue({
    seqNum: () => "42",
  } as unknown as xdr.AccountEntry);

  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
    _parsed: true,
    latestLedger: 1000,
    minResourceFee: "12345",
    transactionData: new SorobanDataBuilder(),
    result: { auth, retval: xdr.ScVal.scvVoid() },
    events: [],
  } as unknown as rpc.Api.SimulateTransactionResponse);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildCtInvokeOp", () => {
  it("round-trips every argument ScVal into the invokeContract op", () => {
    const args = sampleArgs();

    const decoded = readInvokeOp(buildCtInvokeOp(TOKEN, "confidential_transfer", args));

    expect(decoded.contractId).toBe(TOKEN);
    expect(decoded.method).toBe("confidential_transfer");
    expect(decoded.args.map((a) => a.toXDR("base64"))).toEqual(
      args.map((a) => a.toXDR("base64")),
    );
  });

  it("preserves argument order", () => {
    const args = [xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2), xdr.ScVal.scvU32(3)];

    const decoded = readInvokeOp(buildCtInvokeOp(TOKEN, "register", args));

    expect(decoded.args.map((a) => a.u32())).toEqual([1, 2, 3]);
  });

  it("accepts an empty argument list", () => {
    const decoded = readInvokeOp(buildCtInvokeOp(TOKEN, "underlying_asset", []));

    expect(decoded.args).toEqual([]);
  });

  it("rejects a non-contract address", () => {
    expect(() => buildCtInvokeOp(SOURCE, "register", [])).toThrow(TypeError);
  });
});

describe("buildCtInvokeTx", () => {
  it("builds a simulated transaction carrying the encoded args", async () => {
    stubRpc();
    const args = sampleArgs();

    const tx = await buildCtInvokeTx(
      {
        rpcUrl: TESTNET.rpcUrl,
        networkPassphrase: TESTNET.networkPassphrase,
        source: SOURCE,
      },
      TOKEN,
      "deposit",
      args,
    );

    expect(tx.built).toBeDefined();
    expect(tx.built!.source).toBe(SOURCE);
    expect(tx.built!.operations).toHaveLength(1);

    const op = tx.built!.operations[0] as Operation.InvokeHostFunction;
    const invokeArgs = op.func.invokeContract();
    expect(Address.fromScAddress(invokeArgs.contractAddress()).toString()).toBe(TOKEN);
    expect(invokeArgs.functionName().toString()).toBe("deposit");
    expect(invokeArgs.args().map((a) => a.toXDR("base64"))).toEqual(
      args.map((a) => a.toXDR("base64")),
    );
  });

  it("surfaces the auth entries recorded by simulation, still unsigned", async () => {
    const holder = Keypair.random().publicKey();
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(holder).toScAddress(),
          nonce: xdr.Int64.fromString("7"),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(TOKEN).toScAddress(),
            functionName: "merge",
            args: [new Address(holder).toScVal()],
          }),
        ),
        subInvocations: [],
      }),
    });
    stubRpc([entry]);

    const tx = await buildCtInvokeTx(
      {
        rpcUrl: TESTNET.rpcUrl,
        networkPassphrase: TESTNET.networkPassphrase,
        source: SOURCE,
      },
      TOKEN,
      "merge",
      [new Address(holder).toScVal()],
    );

    const auth = tx.simulationData.result.auth;
    expect(auth).toHaveLength(1);
    const credentials = auth[0]!.credentials().address();
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(holder);
    expect(credentials.signature().switch().name).toBe("scvVoid");
  });

  it("propagates a simulation failure when the result is read", async () => {
    vi.spyOn(rpc.Server.prototype, "getAccountEntry").mockResolvedValue({
      seqNum: () => "42",
    } as unknown as xdr.AccountEntry);
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      _parsed: true,
      id: "1",
      latestLedger: 1000,
      error: "HostError: Error(Contract, #4)",
      events: [],
    } as unknown as rpc.Api.SimulateTransactionResponse);

    const tx = await buildCtInvokeTx(
      {
        rpcUrl: TESTNET.rpcUrl,
        networkPassphrase: TESTNET.networkPassphrase,
        source: SOURCE,
      },
      TOKEN,
      "register",
      [],
    );

    expect(() => tx.simulationData).toThrow(/Contract, #4/);
  });
});
