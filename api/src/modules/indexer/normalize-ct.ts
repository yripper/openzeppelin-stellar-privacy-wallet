/**
 * CT event normalizer (Task 8): turns one raw Confidential Token contract
 * event (`events` table row shape, `RawEvent`) into zero or more
 * account-facing `ct_activity` rows.
 *
 * Pure function — no I/O, no `Date.now()`, no randomness. `poller.ts` (the
 * CT stream only) calls this as a post-insert step inside the same Postgres
 * transaction that writes the raw event.
 *
 * Event-shape ground truth: the on-chain field names below (`r_e`, `sigma`,
 * `b_tilde`, `b_aud_s`, `v_tilde`, `v_aud_r`, `r_aud_r`, `v_aud_s`) were
 * decoded from REAL events fetched from the deployed testnet contract
 * (`__fixtures__/ct-events.json`, see `normalize-ct.test.ts`'s module doc
 * for provenance) and match the vendored `@ctd/sdk`'s
 * `packages/ctd-sdk/src/chain/events.ts` `buildConfidentialEvent` mapping
 * EXACTLY. They do NOT match the current Rust source checked out at
 * `resources/stellar-contracts` (branch `feat/confidential-verifier-ultrahonk`,
 * `packages/tokens/src/confidential/mod.rs`), which has since renamed
 * several of these fields (e.g. `b_aud_s` -> `b_tilde_aud_s`). The deployed
 * contract predates that rename; this module follows the fixtures, not the
 * checked-out Rust source, per the task brief ("VERIFY against fixtures —
 * the fixtures are ground truth").
 *
 * Mapping (task-8-brief.md):
 * - `register`/`merge`: single self-row (account === counterparty), no
 *   amount, no ciphertexts (`{}`) — neither event carries any encrypted
 *   field.
 * - `deposit`: a row for `from` and a row for `to`, both with the public
 *   `amount`, no ciphertexts (the event has none — deposit amounts are
 *   plaintext on-chain). When `from === to` (the common self-deposit case),
 *   only ONE row is emitted — a second identical row would double-count the
 *   same on-chain action in that one account's activity feed.
 * - `withdraw`: a row for `from` ONLY (brief: "row for from") — `to` merely
 *   receives plain SEP-41 tokens outside the confidential system and isn't
 *   a CT-tracked account. `amount` is public. `ciphertexts` carries the
 *   withdrawal's checkpoint fields (`rE`/`sigma`/`bTilde`/`bAudS`) — per the
 *   vendored module's own doc note, Withdraw is one of the "checkpoint"
 *   events the sender's local state engine needs to keep syncing its
 *   balance, even though the amount itself is plaintext.
 * - `transfer`: a row for `from` and a row for `to`, `amount: null` (fully
 *   private on-chain), `ciphertexts` carrying the full 8-field set
 *   (`rE`/`vTilde`/`sigma`/`bTilde`/`vAudR`/`rAudR`/`vAudS`/`bAudS`) — all
 *   of it is already public on-chain event data, so sharing the identical
 *   object with both rows costs nothing and guarantees each side's wallet
 *   has every field it might need to decrypt its side of the transfer.
 * - any other topic (a different contract's event, or a CT-emitted-but-
 *   unmapped event such as `spender_transfer`/`set_spender`/
 *   `revoke_spender`/the compliance events/the constructor setter events)
 *   -> `null`.
 *
 * Ciphertext fields are hex-encoded RAW ON-CHAIN BYTES (`0x`-prefixed,
 * lowercase) — the exact `BytesN<32>`/`BytesN<64>` wire layout, not
 * decoded/re-encoded through any curve-point math. This deliberately avoids
 * a dependency on `@ctd/sdk`'s crypto helpers (which pull in the zk-proving
 * stack); the wallet client (Task 11) can decode these hex strings itself
 * with the same byte layout `@ctd/sdk`'s `pointFromBytes`/`fromBytesBE`
 * expect.
 */
import { Address, xdr, scValToNative } from "@stellar/stellar-sdk";
import type { RawEvent } from "../../lib/soroban-events.js";
import type { NewCtActivityRow } from "../../db/schema.js";

/** Alias for the plan's documented return type name (`docs/superpowers/plans/2026-07-31-privacy-wallet.md`). */
export type CtActivityInsert = NewCtActivityRow;

/** The event-name topics (topic[0] symbol) this normalizer maps to `ct_activity` rows. Any other symbol -> `null`. */
const MAPPED_TOPICS = new Set(["register", "deposit", "merge", "withdraw", "transfer"]);

function hexBytes(val: xdr.ScVal): string {
  return `0x${Buffer.from(val.bytes()).toString("hex")}`;
}

/** Source-agnostic accessor over an event's data `ScMap`, keyed by field name (mirrors `@ctd/sdk`'s `dataMap`). */
function dataMapOf(value: xdr.ScVal): Map<string, xdr.ScVal> {
  const map = new Map<string, xdr.ScVal>();
  for (const entry of value.map() ?? []) {
    map.set(entry.key().sym().toString(), entry.val());
  }
  return map;
}

function requireField(data: Map<string, xdr.ScVal>, name: string): xdr.ScVal {
  const v = data.get(name);
  if (v === undefined) throw new Error(`normalizeCtEvent: event data missing field "${name}"`);
  return v;
}

interface RowSeed {
  account: string;
  type: string;
  counterparty: string;
  amount?: string | null;
  ciphertexts?: Record<string, string>;
}

function toRow(raw: RawEvent, seed: RowSeed): CtActivityInsert {
  return {
    account: seed.account,
    type: seed.type,
    counterparty: seed.counterparty,
    amount: seed.amount ?? null,
    ledger: raw.ledger,
    txHash: raw.txHash,
    eventId: raw.id,
    ciphertexts: seed.ciphertexts ?? {},
  };
}

/** Turn one raw CT contract event into its `ct_activity` rows, or `null` if it's not a CT-activity event for `tokenId`. Pure — no I/O. */
export function normalizeCtEvent(raw: RawEvent, tokenId: string): CtActivityInsert[] | null {
  if (raw.contractId !== tokenId) return null;
  if (raw.topic.length === 0) return null;

  const topics = raw.topic.map((t) => xdr.ScVal.fromXDR(t, "base64"));
  const nameScVal = topics[0]!;
  if (nameScVal.switch().name !== "scvSymbol") return null;
  const name = nameScVal.sym().toString();
  if (!MAPPED_TOPICS.has(name)) return null;

  const addr = (i: number): string => Address.fromScVal(topics[i]!).toString();
  const value = xdr.ScVal.fromXDR(raw.valueXdr, "base64");
  const data = dataMapOf(value);

  switch (name) {
    case "register": {
      const account = addr(1);
      return [toRow(raw, { account, type: "register", counterparty: account })];
    }

    case "merge": {
      const account = addr(1);
      return [toRow(raw, { account, type: "merge", counterparty: account })];
    }

    case "deposit": {
      const from = addr(1);
      const to = addr(2);
      const amount = String(scValToNative(requireField(data, "amount")) as bigint);
      const rows = [toRow(raw, { account: from, type: "deposit", counterparty: to, amount })];
      if (to !== from) {
        rows.push(toRow(raw, { account: to, type: "deposit", counterparty: from, amount }));
      }
      return rows;
    }

    case "withdraw": {
      const from = addr(1);
      const to = addr(2);
      const amount = String(scValToNative(requireField(data, "amount")) as bigint);
      const ciphertexts = {
        rE: hexBytes(requireField(data, "r_e")),
        sigma: hexBytes(requireField(data, "sigma")),
        bTilde: hexBytes(requireField(data, "b_tilde")),
        bAudS: hexBytes(requireField(data, "b_aud_s")),
      };
      return [toRow(raw, { account: from, type: "withdraw", counterparty: to, amount, ciphertexts })];
    }

    case "transfer": {
      const from = addr(1);
      const to = addr(2);
      const ciphertexts = {
        rE: hexBytes(requireField(data, "r_e")),
        vTilde: hexBytes(requireField(data, "v_tilde")),
        sigma: hexBytes(requireField(data, "sigma")),
        bTilde: hexBytes(requireField(data, "b_tilde")),
        vAudR: hexBytes(requireField(data, "v_aud_r")),
        rAudR: hexBytes(requireField(data, "r_aud_r")),
        vAudS: hexBytes(requireField(data, "v_aud_s")),
        bAudS: hexBytes(requireField(data, "b_aud_s")),
      };
      const rows = [toRow(raw, { account: from, type: "transfer", counterparty: to, ciphertexts })];
      if (to !== from) {
        rows.push(toRow(raw, { account: to, type: "transfer", counterparty: from, ciphertexts }));
      }
      return rows;
    }

    default:
      return null;
  }
}
