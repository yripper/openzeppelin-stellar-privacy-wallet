/**
 * Postgres schema for the privacy-wallet indexer.
 *
 * Four tables, consumed by:
 * - Task 7 (indexer worker): batch-writes `events`, advances `cursors`,
 *   paginates `bootnode_pages`.
 * - Task 8 (normalizer): reads `events`, writes `ct_activity`.
 * - Task 9 (API server): reads `ct_activity` for account activity feeds.
 */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Raw on-chain events (Confidential Token contract events, RPC or indexer
 * sourced). `id` MUST be constructed as `${ledger}-${txHash}-${opIndex}-${eventIndex}`
 * — this is `@ctd/sdk`'s `naturalEventId` (packages/ctd-sdk/src/chain/events.ts:236),
 * so it dedupes identically whether the row came from the RPC or the Goldsky
 * indexer. Do not invent a different id format here.
 */
export const events = pgTable("events", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull(),
  ledger: integer("ledger").notNull(),
  ledgerClosedAt: timestamp("ledger_closed_at", { withTimezone: true }).notNull(),
  txHash: text("tx_hash").notNull(),
  txIndex: integer("tx_index").notNull(),
  opIndex: integer("op_index").notNull(),
  eventIndex: integer("event_index").notNull(),
  topic: jsonb("topic").notNull(),
  valueXdr: text("value_xdr").notNull(),
  inSuccessfulCall: boolean("in_successful_call").notNull(),
});

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

/**
 * Normalized, account-facing activity derived from `events` by the
 * normalizer (Task 8). One row per confidential-token action
 * (register/deposit/transfer/withdraw/...) visible to `account`.
 */
export const ctActivity = pgTable("ct_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  account: text("account").notNull(),
  type: text("type").notNull(),
  counterparty: text("counterparty").notNull(),
  amount: text("amount"),
  ledger: integer("ledger").notNull(),
  txHash: text("tx_hash").notNull(),
  eventId: text("event_id").notNull(),
  ciphertexts: jsonb("ciphertexts").notNull(),
});

export type CtActivityRow = typeof ctActivity.$inferSelect;
export type NewCtActivityRow = typeof ctActivity.$inferInsert;

/**
 * Generic key/value sync cursors (troqpay shape) — e.g. the indexer's
 * last-processed RPC/indexer paging token, keyed by a stable string like
 * `"events:rpc"`.
 */
export const cursors = pgTable("cursors", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CursorRow = typeof cursors.$inferSelect;
export type NewCursorRow = typeof cursors.$inferInsert;

/**
 * Cache of Nethermind bootnode (SPP) pagination responses, keyed by the
 * request's input cursor so a re-fetch of the same page is idempotent.
 */
export const bootnodePages = pgTable("bootnode_pages", {
  cursorIn: text("cursor_in").primaryKey(),
  request: jsonb("request").notNull(),
  response: jsonb("response").notNull(),
  cursorOut: text("cursor_out").notNull(),
  lastEventLedger: integer("last_event_ledger").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BootnodePageRow = typeof bootnodePages.$inferSelect;
export type NewBootnodePageRow = typeof bootnodePages.$inferInsert;
