/**
 * Confidential Token (CT) rail orchestrator.
 *
 * Thin glue over `@ctd/sdk` — witness building/proving/encoding and
 * chain/state reconstruction are all gate-proven (`docs/modules/ctd-sdk.md`,
 * `docs/modules/ct-tx.md`) — plus `buildCtInvokeTx` + `kit.signAndSubmit`
 * for the smart-account C-address auth split (`@ctd/sdk`'s own
 * `ChainClient.invoke`/`submit*` helpers assume the tx source IS the sole
 * auth principal, which only holds for a plain G-address signer; see
 * `docs/modules/ct-tx.md`). Every write op follows the same shape:
 *
 *   witness (-> prove, where a proof is required) -> encode -> buildCtInvokeTx
 *   -> kit.signAndSubmit (WebAuthn auth-entry signing + fee sponsoring,
 *      internal to the kit) -> StateEngine.sync()
 *
 * Mirrors the method/arg-order sequencing gate #1 proved
 * (`scripts/smoke-ct.ts`'s `invokeAsSmartAccount` calls) and the reference
 * demo's `ConfidentialWallet` shape
 * (`resources/stellar-confidential-token-demo/packages/app/lib/wallet.ts`),
 * adapted from a Freighter G-address signer to a passkey smart-account
 * C-address.
 */
import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  DOMAIN,
  H,
  LocalStorageStore,
  StateEngine,
  ChainClient,
  buildRegisterWitness,
  buildTransferWitness,
  buildWithdrawWitness,
  decryptWithDomain,
  deriveEphemeralRE,
  deserializeKeys,
  ecdh,
  encodeRegisterData,
  encodeTransferData,
  encodeWithdrawData,
  proverFromArtifact,
  scalarMul,
  type CircuitProver,
  type ConfidentialEvent,
  type KeyPair,
  type SerializedKeyPair,
  type TransferEvent,
} from "@ctd/sdk";
import registerCircuit from "@ctd/sdk/circuits/register.json";
import transferCircuit from "@ctd/sdk/circuits/transfer.json";
import withdrawCircuit from "@ctd/sdk/circuits/withdraw.json";
import { TESTNET, buildCtInvokeTx } from "@grantfox/shared";

import { kit } from "./kit.js";
import { ensureBrowserBackend } from "./bb-loader.js";
import { ApiIndexerClient } from "./ct-indexer.js";

/** `@grantfox/api`'s base URL — the same base the wallet reads its activity feed from. */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3000";

type CircuitName = "register" | "transfer" | "withdraw";

const CIRCUITS: Record<CircuitName, { bytecode: string } & Record<string, unknown>> = {
  register: registerCircuit as never,
  transfer: transferCircuit as never,
  withdraw: withdrawCircuit as never,
};

const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

/** UI-ready balance snapshot. Amounts are stroops (bigint) — 1 XLM = 10_000_000 stroops. */
export interface CtView {
  registered: boolean;
  /** Public (non-confidential) XLM balance of the C-address, via the underlying SAC. */
  publicXlm: bigint;
  /** Confidential spendable balance (send-able immediately). */
  spendable: bigint;
  /** Confidential receiving balance (not yet merged into spendable). */
  receiving: bigint;
  syncedLedger: number;
  /** Null until `registered`; then whether the local reconstructed state re-commits to the on-chain points. */
  matchesChain: boolean | null;
}

/**
 * Orchestrates the Confidential Token rail for one wallet (the connected
 * smart-account C-address). One instance per session — holds the lazily
 * created bb.js provers (expensive: WASM + CRS init) and the local
 * `StateEngine` (persisted openings in `localStorage`).
 */
export class CtRail {
  #provers = new Map<CircuitName, CircuitProver>();

  private constructor(
    readonly address: string,
    private keys: KeyPair,
    private client: ChainClient,
    private engine: StateEngine,
    readonly indexer: ApiIndexerClient,
  ) {}

  /** @param cAddress - The wallet's smart-account C-address. @param ctKeys - `PrivacyBundle.ctKeys` (already bound to `TESTNET.ct.token`'s addr_f — see `privacy-bundle.ts`). */
  static connect(cAddress: string, ctKeys: SerializedKeyPair): CtRail {
    ensureBrowserBackend();
    const keys = deserializeKeys(ctKeys);
    const client = new ChainClient({
      rpcUrl: TESTNET.rpcUrl,
      networkPassphrase: TESTNET.networkPassphrase,
      contracts: { token: TESTNET.ct.token, verifier: TESTNET.ct.verifier, auditor: TESTNET.ct.auditor },
    });
    const indexer = new ApiIndexerClient({ baseUrl: API_URL });
    const engine = new StateEngine({
      client,
      store: new LocalStorageStore(`grantfox:ct:${TESTNET.ct.token}:`),
      keys,
      address: cAddress,
      // hybridFetchEvents clamps the RPC leg to its retention window and
      // routes anything older to `indexer` (our API's XDR-decoding adapter).
      fromLedger: TESTNET.ct.deployedAtLedger,
      indexer,
    });
    return new CtRail(cAddress, keys, client, engine, indexer);
  }

  private prover(name: CircuitName): CircuitProver {
    let p = this.#provers.get(name);
    if (!p) {
      p = proverFromArtifact(CIRCUITS[name]);
      this.#provers.set(name, p);
    }
    return p;
  }

  /**
   * Build, sign (WebAuthn, via the kit), and submit a CT contract call.
   * `buildCtInvokeTx`'s `source` is the kit's own deterministic deployer
   * G-address (`kit.deployerPublicKey`) — the same account
   * `kit.signAndSubmit`'s internal re-simulation always re-sources from
   * (`resources/smart-account-kit/src/kit/tx-ops.ts`'s
   * `signResimulateAndPrepare`), so this is consistent with what actually
   * gets submitted, not just a placeholder discarded on re-simulation. The
   * fee itself is sponsored via the relayer (`shouldUseFeeSponsoring`); this
   * account only needs to exist on-chain, not hold a balance.
   */
  private async invoke(method: string, args: xdr.ScVal[]): Promise<string> {
    const tx = await buildCtInvokeTx(
      { rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.networkPassphrase, source: kit.deployerPublicKey },
      TESTNET.ct.token,
      method,
      args,
    );
    const result = await kit.signAndSubmit(tx);
    if (!result.success) {
      throw new Error(result.error.message);
    }
    return result.hash;
  }

  /** CT contract read (simulate): is `address` registered for confidential balances? Drives the recipient-paste check in SendForm. */
  async isRegistered(address: string): Promise<boolean> {
    return this.client.isRegistered(address);
  }

  /** Public (non-confidential) XLM balance of this wallet's C-address, via the underlying SAC's `balance` (simulation — `getAccount` doesn't resolve a C-address). */
  async publicBalance(): Promise<bigint> {
    const retval = await this.client.simulate(TESTNET.nativeSac, "balance", [addr(this.address)]);
    return scValToNative(retval) as bigint;
  }

  /** Register this wallet's confidential account (one-shot per address). */
  async register(): Promise<string> {
    const w = buildRegisterWitness(this.keys);
    const { proof } = await this.prover("register").prove(w.inputs);
    return this.invoke("register", [
      addr(this.address),
      xdr.ScVal.scvU32(TESTNET.ct.auditorId),
      encodeRegisterData(w, proof),
    ]);
  }

  /** Public -> confidential: move `amount` stroops of public XLM into this wallet's own receiving balance. No proof (the amount stays public on-chain until merged). */
  async deposit(amount: bigint): Promise<string> {
    return this.invoke("deposit", [addr(this.address), addr(this.address), i128(amount)]);
  }

  /** Fold the receiving balance into spendable. No proof. */
  async merge(): Promise<string> {
    return this.invoke("merge", [addr(this.address)]);
  }

  /** Confidential -> confidential: send `amount` stroops from this wallet's spendable balance to `to` (must already be registered). */
  async transfer(to: string, amount: bigint): Promise<string> {
    const recipient = await this.client.confidentialBalance(to);
    if (!recipient) {
      throw new Error("Recipient has not activated confidential transfers yet.");
    }
    const [kAudR, kAudS] = await Promise.all([
      this.client.auditorKey(recipient.auditorId),
      this.client.auditorKey(TESTNET.ct.auditorId),
    ]);

    const s = await this.engine.sync();
    if (s.spendable.v < amount) {
      throw new Error("Insufficient spendable balance.");
    }

    const w = buildTransferWitness({
      keys: this.keys,
      v: s.spendable.v,
      r: s.spendable.r,
      amount,
      pvkB: recipient.viewingPublicKey,
      kAudR,
      kAudS,
    });
    const { proof } = await this.prover("transfer").prove(w.inputs);
    const hash = await this.invoke("confidential_transfer", [
      addr(this.address),
      addr(to),
      encodeTransferData(w, proof),
    ]);
    // Optimistic local update so the UI doesn't wait a round-trip for the
    // event; the next refresh() reconciles against chain via engine.sync().
    await this.engine.setSpendable(w.next);
    return hash;
  }

  /** Confidential -> public: move `amount` stroops of spendable balance back to public XLM. */
  async withdraw(amount: bigint): Promise<string> {
    const kAudS = await this.client.auditorKey(TESTNET.ct.auditorId);
    const s = await this.engine.sync();
    if (s.spendable.v < amount) {
      throw new Error("Insufficient spendable balance.");
    }

    const w = buildWithdrawWitness({ keys: this.keys, v: s.spendable.v, r: s.spendable.r, amount, kAudS });
    const { proof } = await this.prover("withdraw").prove(w.inputs);
    const hash = await this.invoke("withdraw", [
      addr(this.address),
      addr(this.address),
      i128(amount),
      encodeWithdrawData(w, proof),
    ]);
    await this.engine.setSpendable(w.next);
    return hash;
  }

  /** Sync from chain events, verify the reconstructed openings against the on-chain commitments, and read a UI-ready balance snapshot. */
  async refresh(): Promise<CtView> {
    const [state, onchain, publicXlm] = await Promise.all([
      this.engine.sync(),
      this.client.confidentialBalance(this.address),
      this.publicBalance(),
    ]);
    const matchesChain = onchain ? (await this.engine.verifyAgainstChain()).ok : null;
    return {
      registered: onchain !== null,
      publicXlm,
      spendable: state.spendable.v,
      receiving: state.receiving.v,
      syncedLedger: state.syncedLedger,
      matchesChain,
    };
  }

  /**
   * Resolve a `ct_activity` feed row's full on-chain event via our API's
   * XDR-decoding adapter (`ct-indexer.ts`) — the activity feed's route to a
   * `transfer` row's decryptable fields (`rE`/`vTilde`/`sigma`/…).
   */
  async resolveActivityEvent(row: {
    ledger: number;
    eventId: string;
    txHash: string;
  }): Promise<ConfidentialEvent | null> {
    return this.indexer.resolveEventRef(TESTNET.ct.token, {
      ledger: row.ledger,
      id: row.eventId,
      txHash: row.txHash,
    });
  }

  /**
   * Decrypt a confidential transfer's amount for local display, from
   * whichever side this wallet is on. Mirrors
   * `resources/stellar-confidential-token-demo/packages/app/lib/wallet.ts:327-368`
   * (`recoverRE`/`transferAmount`):
   *   - inbound (`to === this.address`): ECDH with this wallet's own viewing
   *     key (`StateEngine.decryptIncoming`).
   *   - outbound (`from === this.address`): re-derive the deterministic
   *     ephemeral scalar `r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma)`, check it
   *     against the event's public `R_e`, then ECDH against the recipient's
   *     on-chain public viewing key.
   * Returns `null` when this wallet can't recover it here (an outbound
   * transfer not built with these keys, or a recipient with no on-chain
   * account record) — the amount stays confidential on-chain regardless.
   */
  async decryptTransferAmount(event: TransferEvent): Promise<bigint | null> {
    if (event.to === this.address) {
      return this.engine.decryptIncoming(event.rE, event.vTilde, event.sigma).vTx;
    }
    if (event.from === this.address) {
      const derived = deriveEphemeralRE(this.keys.vk, event.sigma);
      const derivedRE = scalarMul(derived, H);
      if (!derivedRE.equals(event.rE)) return null;
      const recipient = await this.client.confidentialBalance(event.to);
      if (!recipient) return null;
      const sBx = ecdh(derived, recipient.viewingPublicKey);
      const vTx = decryptWithDomain(event.vTilde, DOMAIN.TX_AMOUNT, sBx, event.sigma);
      if (vTx >= 1n << 127n) return null; // a wrong key yields garbage far outside the amount range
      return vTx;
    }
    return null;
  }

  /** Free every cached bb.js prover (worker + WASM) before discarding this rail. */
  async destroy(): Promise<void> {
    await Promise.all([...this.#provers.values()].map((p) => p.destroy()));
    this.#provers.clear();
  }
}
