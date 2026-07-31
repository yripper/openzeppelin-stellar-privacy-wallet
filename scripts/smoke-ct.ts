/**
 * Gate #1 — the full Confidential Token lifecycle driven from Node, with the
 * confidential account owned by an OpenZeppelin smart-account **C-address**.
 *
 * This is the make-or-break integration check for the privacy wallet: the CT
 * demo only ever exercised G-address holders (`keypairSigner` + `ChainClient`,
 * where the transaction source *is* the auth principal). Our wallet's holder is
 * a smart account, so every CT call needs a `__check_auth` AuthPayload signed
 * out-of-band and a separate fee payer.
 *
 *   deploy smart account (External ed25519 signer)  → C
 *     → friendbot-fund C (native XLM lands in the SAC balance)
 *     → register(C)         [C-address auth + on-chain UltraHonk proof]
 *     → register(bob)       [plain G-address, the transfer counterparty]
 *     → deposit(C → C, 100 XLM) → merge(C)
 *     → confidential_transfer(C → bob, 40 XLM)
 *     → bob decrypts his credit from the event
 *     → withdraw(C → C, 60 XLM)
 *
 * Every step asserts the locally reconstructed openings re-commit to the exact
 * points stored on-chain (`StateEngine.verifyAgainstChain`), and the public SAC
 * balance of the C-address is checked before/after the deposit and withdraw.
 *
 * Usage: pnpm exec tsx scripts/smoke-ct.ts
 * Uses fresh friendbot-funded accounts on every run (register is one-shot per
 * address, so the C-address must be new each time).
 */

import {
  Address,
  Keypair,
  Operation,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import {
  Ed25519Signer,
  computeEntryAuthDigest,
  resimulateAndAssemble,
  signerToScVal,
} from "smart-account-kit";
import { Client as SmartAccountClient } from "smart-account-kit-bindings";
import {
  ChainClient,
  CircuitProver,
  MemoryStore,
  StateEngine,
  addressToField,
  buildRegisterWitness,
  buildTransferWitness,
  buildWithdrawWitness,
  encodeRegisterData,
  encodeTransferData,
  encodeWithdrawData,
  generateKeys,
  keypairSigner,
  submitMerge,
  submitRegister,
  type KeyPair,
  type Point,
} from "@ctd/sdk";
import { loadCircuit } from "@ctd/sdk/proving/artifacts";
import { TESTNET, buildCtInvokeTx } from "@grantfox/shared";

const { rpcUrl, networkPassphrase } = TESTNET;
const { token, auditorId, deployedAtLedger } = TESTNET.ct;
const { accountWasmHash, ed25519VerifierAddress } = TESTNET.smartAccount;

/** 100 XLM in stroops — the CT amounts are the underlying SAC's own units. */
const DEPOSIT = 100_0000000n;
const TRANSFER = 40_0000000n;
const WITHDRAW = DEPOSIT - TRANSFER;

/**
 * The smart account's `__constructor` installs its signers under a single
 * `Default` context rule, and `add_context_rule` hands out ids from a counter
 * that starts at 0 (`stellar-contracts` `smart_account/storage.rs:634`), so a
 * freshly deployed account's only rule is id 0. Verified on-chain at runtime by
 * {@link assertDefaultContextRule} rather than trusted blindly.
 */
const DEFAULT_CONTEXT_RULE_ID = 0;

/** Ledgers of validity for the auth-entry signatures we mint. */
const AUTH_EXPIRY_LEDGERS = 120;

const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function log(msg: string): void {
  console.log(msg);
}

// ---------------------------------------------------------------------------
// Smart-account auth-entry signing
// ---------------------------------------------------------------------------

/**
 * Read the address credentials out of an auth entry, or `null` when the entry
 * is source-account authorized (those need no AuthPayload).
 *
 * Simulation currently hands back legacy v1 credentials; v2 (CAP-71) is handled
 * too so this keeps working once the network flips the default.
 */
function addressCredentials(
  entry: xdr.SorobanAuthorizationEntry,
): xdr.SorobanAddressCredentials | null {
  const credentials = entry.credentials();
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return credentials.address();
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2();
    default:
      return null;
  }
}

/**
 * Encode a smart-account `AuthPayload` — `{ context_rule_ids: Vec<u32>,
 * signers: Map<Signer, Bytes> }` — as the `ScVal` the contract's `__check_auth`
 * decodes from the entry's signature slot.
 *
 * Field order matters: the host rejects an `ScMap` whose symbol keys are not in
 * ascending order, and `context_rule_ids` < `signers`. With a single signer the
 * inner map needs no sorting.
 */
function authPayloadScVal(
  contextRuleIds: number[],
  signer: Ed25519Signer,
  signature: Buffer,
): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerToScVal(signer.signer),
          val: xdr.ScVal.scvBytes(signature),
        }),
      ]),
    }),
  ]);
}

interface SmartAccountAuth {
  /** The smart account (`C…`) whose entries this signs. */
  address: string;
  signer: Ed25519Signer;
  /** Context rule authorizing the calls — `Default` matches every context. */
  contextRuleId: number;
}

/**
 * Count the auth contexts the host will derive from an entry: the root
 * invocation plus every sub-invocation, depth-first.
 *
 * `do_check_auth` rejects the payload unless `context_rule_ids.len()` equals
 * `auth_contexts.len()` (`stellar-contracts` `smart_account/storage.rs:468`) —
 * the ids are positionally aligned with the contexts, one per invocation. A
 * `deposit` is two contexts, not one: the CT contract re-enters the underlying
 * SAC's `transfer` on the holder's behalf.
 */
function countAuthContexts(entry: xdr.SorobanAuthorizationEntry): number {
  const walk = (invocation: xdr.SorobanAuthorizedInvocation): number =>
    invocation.subInvocations().reduce((n, sub) => n + walk(sub), 1);
  return walk(entry.rootInvocation());
}

/**
 * Sign every auth entry belonging to `auth.address`, leaving the rest untouched.
 *
 * `computeEntryAuthDigest` writes the normalized expiration into the entry it is
 * given as a side effect, which is exactly what we want: the ledger bound in the
 * digest and the one in the submitted `SorobanAddressCredentials` are then the
 * same by construction.
 */
function signAuthEntries(
  entries: xdr.SorobanAuthorizationEntry[],
  auth: SmartAccountAuth,
  expirationLedger: number,
): { signed: xdr.SorobanAuthorizationEntry[]; count: number } {
  let count = 0;
  const signed = entries.map((entry) => {
    const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const credentials = addressCredentials(clone);
    if (!credentials) return clone;
    if (Address.fromScAddress(credentials.address()).toString() !== auth.address) return clone;

    const contextRuleIds = new Array<number>(countAuthContexts(clone)).fill(auth.contextRuleId);
    const { authDigest } = computeEntryAuthDigest(
      networkPassphrase,
      clone,
      expirationLedger,
      contextRuleIds,
    );
    const signature = auth.signer.signAuthDigest(authDigest);
    credentials.signature(authPayloadScVal(contextRuleIds, auth.signer, signature));
    count += 1;
    return clone;
  });
  return { signed, count };
}

/**
 * Invoke a confidential-token entry point whose auth principal is the smart
 * account: build + simulate via the shared `buildCtInvokeTx`, sign the recorded
 * C-address auth entries, re-simulate with the signatures in place (so the host
 * charges for the real `__check_auth` work), then pay and submit with `feeKp`.
 */
async function invokeAsSmartAccount(
  feeKp: Keypair,
  auth: SmartAccountAuth,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const tx = await buildCtInvokeTx(
    { rpcUrl, networkPassphrase, source: feeKp.publicKey() },
    token,
    method,
    args,
  );

  const entries = tx.simulationData.result.auth;
  const latestLedger = (await server.getLatestLedger()).sequence;
  const { signed, count } = signAuthEntries(
    entries,
    auth,
    latestLedger + AUTH_EXPIRY_LEDGERS,
  );
  assert(
    count > 0,
    `${method}: simulation recorded no auth entry for ${auth.address} ` +
      `(entries: ${entries.length}) — the call would not exercise the smart account`,
  );

  const built = tx.built;
  assert(built !== undefined, `${method}: transaction was not built`);
  const op = built!.operations[0] as Operation.InvokeHostFunction;

  const source = await server.getAccount(feeKp.publicKey());
  const prepared = await resimulateAndAssemble(
    { rpc: server, networkPassphrase, timeoutInSeconds: 180 },
    source,
    op.func,
    signed,
  );
  prepared.sign(feeKp);

  return submit(prepared, method);
}

async function submit(tx: Transaction, label: string): Promise<string> {
  const send = await server.sendTransaction(tx);
  if (send.status === "ERROR") {
    throw new Error(`${label}: submission rejected — ${send.errorResult?.toXDR("base64")}`);
  }
  const result = await server.pollTransaction(send.hash, {
    attempts: 30,
    sleepStrategy: rpc.LinearSleepStrategy,
  });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      `${label}: failed on-chain (tx ${send.hash}, status ${result.status})` +
        (result.status === rpc.Api.GetTransactionStatus.FAILED
          ? ` — ${result.resultXdr?.toXDR("base64")}`
          : ""),
    );
  }
  return send.hash;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/** Deploy a smart account whose only signer is `signer`, paid for by `feeKp`. */
async function deploySmartAccount(feeKp: Keypair, signer: Ed25519Signer): Promise<string> {
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const tx = await SmartAccountClient.deploy(
    { signers: [signer.signer], policies: new Map() },
    {
      networkPassphrase,
      rpcUrl,
      allowHttp: rpcUrl.startsWith("http://"),
      wasmHash: accountWasmHash,
      salt,
      publicKey: feeKp.publicKey(),
      signTransaction: feeKp,
      timeoutInSeconds: 180,
    },
  );
  const sent = await tx.signAndSend();
  const deployed = sent.result;
  const contractId = deployed.options.contractId;
  assert(
    contractId.startsWith("C") && contractId.length === 56,
    `smart-account deploy returned a non-contract address: ${contractId}`,
  );
  return contractId;
}

/**
 * Confirm the freshly deployed account really does authorize our signer under
 * {@link DEFAULT_CONTEXT_RULE_ID} — the id the AuthPayload will claim.
 */
async function assertDefaultContextRule(cAddress: string, signer: Ed25519Signer): Promise<void> {
  const client = new SmartAccountClient({
    contractId: cAddress,
    networkPassphrase,
    rpcUrl,
    allowHttp: rpcUrl.startsWith("http://"),
  });
  const { result } = await client.get_context_rule({
    context_rule_id: DEFAULT_CONTEXT_RULE_ID,
  });
  assert(
    result.context_type.tag === "Default",
    `context rule ${DEFAULT_CONTEXT_RULE_ID} is ${result.context_type.tag}, expected Default`,
  );
  const key = signer.publicKey.toString("hex");
  const installed = result.signers.some(
    (s) =>
      s.tag === "External" &&
      s.values[0] === ed25519VerifierAddress &&
      Buffer.from(s.values[1]).toString("hex") === key,
  );
  assert(installed, `ed25519 signer is not installed in context rule ${DEFAULT_CONTEXT_RULE_ID}`);
}

/** Public (non-confidential) balance of `address` in the underlying SAC. */
async function publicBalance(client: ChainClient, address: string): Promise<bigint> {
  const retval = await client.simulate(TESTNET.ct.underlying, "balance", [addr(address)]);
  return scValToNative(retval) as bigint;
}

async function freshFundedAccount(label: string): Promise<Keypair> {
  const kp = Keypair.random();
  await server.fundAddress(kp.publicKey());
  log(`  ${label} = ${kp.publicKey()}`);
  return kp;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`token   = ${token}`);
  log(`rpc     = ${rpcUrl}`);

  const client = new ChainClient({
    rpcUrl,
    networkPassphrase,
    contracts: { token, verifier: TESTNET.ct.verifier, auditor: TESTNET.ct.auditor },
  });

  // Keys are bound to the TOKEN contract's address-as-field (the contract
  // recomputes it from its own storage when verifying), not to the holder's.
  const addrF = addressToField(token);
  assert(
    addrF === BigInt(TESTNET.ct.addrF),
    `addr_f drift: computed 0x${addrF.toString(16)}, config ${TESTNET.ct.addrF}`,
  );
  const kAud: Point = await client.auditorKey(auditorId);

  const registerProver = new CircuitProver(loadCircuit("register"));
  const transferProver = new CircuitProver(loadCircuit("transfer"));
  const withdrawProver = new CircuitProver(loadCircuit("withdraw"));

  try {
    log("\n[accounts]");
    const feeKp = await freshFundedAccount("fee payer");
    const bobKp = await freshFundedAccount("bob (G)");
    const signerKp = Keypair.random();
    const signer = new Ed25519Signer(signerKp, ed25519VerifierAddress);
    log(`  smart-account signer = ${signer.address} (External via ${ed25519VerifierAddress})`);

    log("\n[smart account]");
    const cAddress = await deploySmartAccount(feeKp, signer);
    log(`  deployed = ${cAddress}`);
    await assertDefaultContextRule(cAddress, signer);
    log(`  context rule ${DEFAULT_CONTEXT_RULE_ID} = Default, signer installed ✓`);

    await server.fundAddress(cAddress);
    const fundedBalance = await publicBalance(client, cAddress);
    assert(fundedBalance > DEPOSIT, `friendbot funded C with only ${fundedBalance} stroops`);
    log(`  friendbot-funded, public SAC balance = ${fundedBalance} stroops`);

    const auth: SmartAccountAuth = {
      address: cAddress,
      signer,
      contextRuleId: DEFAULT_CONTEXT_RULE_ID,
    };

    const keys: KeyPair = generateKeys(addrF);
    const bobKeys: KeyPair = generateKeys(addrF);
    const engine = new StateEngine({
      client,
      store: new MemoryStore(),
      keys,
      address: cAddress,
      fromLedger: deployedAtLedger,
    });
    const bobEngine = new StateEngine({
      client,
      store: new MemoryStore(),
      keys: bobKeys,
      address: bobKp.publicKey(),
      fromLedger: deployedAtLedger,
    });

    log("\n[register]");
    {
      const w = buildRegisterWitness(keys);
      const { proof } = await registerProver.prove(w.inputs);
      const hash = await invokeAsSmartAccount(feeKp, auth, "register", [
        addr(cAddress),
        xdr.ScVal.scvU32(auditorId),
        encodeRegisterData(w, proof),
      ]);
      log(`  C registered (tx ${hash}) — smart-account auth + on-chain proof OK`);

      const onchain = await client.confidentialBalance(cAddress);
      assert(onchain !== null, "C is not registered on-chain after register");
      assert(
        onchain!.spendingKey.equals(keys.Y) && onchain!.viewingPublicKey.equals(keys.PVK),
        "on-chain register keys do not match the local key set",
      );
      assert(onchain!.auditorId === auditorId, `auditor_id mismatch: ${onchain!.auditorId}`);
    }
    {
      const w = buildRegisterWitness(bobKeys);
      const { proof } = await registerProver.prove(w.inputs);
      const r = await submitRegister(
        client,
        keypairSigner(bobKp.secret(), networkPassphrase),
        bobKp.publicKey(),
        auditorId,
        w,
        proof,
      );
      log(`  bob registered (tx ${r.hash})`);
    }

    log(`\n[deposit + merge] C deposits ${DEPOSIT} stroops`);
    const beforeDeposit = await publicBalance(client, cAddress);
    {
      const hash = await invokeAsSmartAccount(feeKp, auth, "deposit", [
        addr(cAddress),
        addr(cAddress),
        i128(DEPOSIT),
      ]);
      log(`  deposited (tx ${hash})`);
    }
    {
      const hash = await invokeAsSmartAccount(feeKp, auth, "merge", [addr(cAddress)]);
      log(`  merged (tx ${hash})`);
    }
    {
      const afterDeposit = await publicBalance(client, cAddress);
      assert(
        afterDeposit === beforeDeposit - DEPOSIT,
        `public balance after deposit = ${afterDeposit}, want ${beforeDeposit - DEPOSIT}`,
      );

      const s = await engine.sync();
      const v = await engine.verifyAgainstChain();
      assert(s.spendable.v === DEPOSIT, `C spendable v=${s.spendable.v}, want ${DEPOSIT}`);
      assert(v.ok, `C state mismatch after merge: ${JSON.stringify(v)}`);
      log(`  C spendable = ${s.spendable.v} (public balance debited, state matches chain ✓)`);
    }

    log(`\n[transfer] C → bob ${TRANSFER} stroops`);
    {
      const s = await engine.current();
      const w = buildTransferWitness({
        keys,
        v: s.spendable.v,
        r: s.spendable.r,
        amount: TRANSFER,
        pvkB: bobKeys.PVK,
        kAudR: kAud,
        kAudS: kAud,
      });
      const { proof } = await transferProver.prove(w.inputs);
      const hash = await invokeAsSmartAccount(feeKp, auth, "confidential_transfer", [
        addr(cAddress),
        addr(bobKp.publicKey()),
        encodeTransferData(w, proof),
      ]);
      log(`  transferred (tx ${hash}) — smart-account auth + on-chain proof OK`);
    }
    {
      const s = await engine.sync();
      const v = await engine.verifyAgainstChain();
      assert(
        s.spendable.v === DEPOSIT - TRANSFER,
        `C spendable v=${s.spendable.v}, want ${DEPOSIT - TRANSFER}`,
      );
      assert(v.ok, `C state mismatch after transfer: ${JSON.stringify(v)}`);
      log(`  C spendable = ${s.spendable.v} (✓)`);

      const b = await bobEngine.sync();
      const bv = await bobEngine.verifyAgainstChain();
      assert(b.receiving.v === TRANSFER, `bob receiving v=${b.receiving.v}, want ${TRANSFER}`);
      assert(bv.ok, `bob state mismatch: ${JSON.stringify(bv)}`);
      log(`  bob receiving = ${b.receiving.v} (ECDH-decrypted from the event, matches chain ✓)`);
    }

    log(`\n[merge + withdraw] C withdraws ${WITHDRAW} stroops back to public`);
    const beforeWithdraw = await publicBalance(client, cAddress);
    {
      const s = await engine.current();
      const w = buildWithdrawWitness({
        keys,
        v: s.spendable.v,
        r: s.spendable.r,
        amount: WITHDRAW,
        kAudS: kAud,
      });
      const { proof } = await withdrawProver.prove(w.inputs);
      const hash = await invokeAsSmartAccount(feeKp, auth, "withdraw", [
        addr(cAddress),
        addr(cAddress),
        i128(WITHDRAW),
        encodeWithdrawData(w, proof),
      ]);
      log(`  withdrew (tx ${hash}) — smart-account auth + on-chain proof OK`);
    }
    {
      const afterWithdraw = await publicBalance(client, cAddress);
      assert(
        afterWithdraw === beforeWithdraw + WITHDRAW,
        `public balance after withdraw = ${afterWithdraw}, want ${beforeWithdraw + WITHDRAW}`,
      );

      const s = await engine.sync();
      const v = await engine.verifyAgainstChain();
      assert(s.spendable.v === 0n, `C spendable v=${s.spendable.v}, want 0`);
      assert(v.ok, `C final state mismatch: ${JSON.stringify(v)}`);
      log(`  C spendable = ${s.spendable.v}, public balance credited (✓)`);
    }

    log("\n[bob merge + withdraw]");
    {
      await submitMerge(client, keypairSigner(bobKp.secret(), networkPassphrase), bobKp.publicKey());
      const s = await bobEngine.sync();
      assert(s.spendable.v === TRANSFER, `bob spendable v=${s.spendable.v}, want ${TRANSFER}`);
      const bv = await bobEngine.verifyAgainstChain();
      assert(bv.ok, `bob state mismatch after merge: ${JSON.stringify(bv)}`);
      log(`  bob spendable = ${s.spendable.v} (✓)`);
    }

    log(`\n✅ gate #1 passed — full CT lifecycle from a C-address smart account.`);
    log(`   smart account: ${cAddress}`);
  } finally {
    await Promise.all([
      registerProver.destroy(),
      transferProver.destroy(),
      withdrawProver.destroy(),
    ]);
  }
}

main().catch((e: unknown) => {
  console.error("\n❌", e);
  process.exit(1);
});
