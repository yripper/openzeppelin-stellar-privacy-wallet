import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  bootnodePages,
  ctActivity,
  cursors,
  events,
  type BootnodePageRow,
  type CtActivityRow,
  type EventRow,
  type NewBootnodePageRow,
  type NewCtActivityRow,
  type NewEventRow,
} from "./schema.js";

/**
 * Either the top-level `Db` handle or the transaction handle drizzle passes
 * into `db.transaction(tx => ...)`. Both expose the same query-builder
 * surface (`.insert`/`.select`/...) that `buildRepoOps` uses.
 */
type Queryable = Db | (Parameters<Db["transaction"]>[0] extends (tx: infer Tx) => unknown ? Tx : never);

/** Ledger window query shared by `listEventsFromLedger`'s and `listEventsAfterId`'s options (Task 9). */
export interface EventsWindowQuery {
  contractIds: string[];
  /** Inclusive lower ledger bound. */
  fromLedger: number;
  /** Inclusive upper ledger bound; omit for none. */
  toLedger?: number;
  limit: number;
}

export interface EventsAfterIdQuery {
  contractIds: string[];
  afterId: string;
  /** Inclusive upper ledger bound; omit for none. */
  toLedger?: number;
  limit: number;
}

export interface AccountActivityQuery {
  account: string;
  limit: number;
}

export interface AccountActivityBeforeIdQuery {
  account: string;
  beforeId: string;
  limit: number;
}

/** Insert/query helpers shared by the top-level repo and its `withTransaction` scope. */
export interface RepoOps {
  /** Batch-insert events; rows whose `id` already exists are skipped (idempotent re-runs across restarts). */
  insertEvents(rows: NewEventRow[]): Promise<void>;
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;
  /** Batch-insert normalized activity rows produced by the normalizer (Task 8). */
  insertCtActivity(rows: NewCtActivityRow[]): Promise<void>;
  /** Cache a bootnode page fetch; idempotent by `cursorIn` (the page's input cursor). */
  insertBootnodePage(row: NewBootnodePageRow): Promise<void>;
  getBootnodePage(cursorIn: string): Promise<BootnodePageRow | null>;

  /**
   * Events for `contractIds` with `ledger >= fromLedger` (and `<= toLedger`
   * when given), ordered ASCENDING by real chain position — `(ledger,
   * txIndex, opIndex, eventIndex)`, NOT string `id` order. `events.id` is
   * `${ledger}-${txHash}-${opIndex}-${eventIndex}` with no zero-padding, so a
   * naive `ORDER BY id` would sort e.g. ledger `1000000000` before
   * `999999999` lexicographically — wrong. Used by the REST
   * `/contracts/:contractId/events` route (Task 9) and the bootnode
   * `getEvents` handler's `startLedger` path (Task 9).
   */
  listEventsFromLedger(query: EventsWindowQuery): Promise<EventRow[]>;
  /**
   * Events strictly AFTER `afterId`'s chain position (same ordering/scope as
   * {@link listEventsFromLedger}). Returns `null` if `afterId` doesn't exist
   * among `contractIds`' rows (an unresolvable/stale cursor, or one minted
   * for a different contract set) — callers map this to their own
   * protocol's cursor-not-found error (REST: 400 `INVALID_ARGUMENT`;
   * bootnode: `-32004` cache miss).
   */
  listEventsAfterId(query: EventsAfterIdQuery): Promise<EventRow[] | null>;
  /**
   * `{min, max}` ledger among `contractIds`' rows, or ALL rows if
   * `contractIds` is omitted — `null` if none match. Backs `/health`'s
   * `latest_synced_ledger`, the events route's `latestLedger`, and the
   * bootnode handler's "our indexed tip" handoff check.
   */
  getLedgerBounds(contractIds?: string[]): Promise<{ min: number; max: number } | null>;

  /** `ct_activity` rows for `account`, NEWEST first (`ledger DESC`, tiebroken by `id DESC` — `id` is a random `uuid`, so the tiebreak is deterministic-but-not-chronological among same-ledger rows; acceptable at ledger granularity for an activity feed). Backs `GET /accounts/:address/activity`. */
  listActivityForAccount(query: AccountActivityQuery): Promise<CtActivityRow[]>;
  /** `ct_activity` rows for `account` strictly OLDER than `beforeId`'s `(ledger, id)` position (same ordering as {@link listActivityForAccount}). Returns `null` if `beforeId` doesn't exist for `account`. */
  listActivityForAccountBeforeId(query: AccountActivityBeforeIdQuery): Promise<CtActivityRow[] | null>;
}

export interface IndexerRepo extends RepoOps {
  /** Run `fn` against a repo scoped to a single Postgres transaction. */
  withTransaction<T>(fn: (repo: RepoOps) => Promise<T>): Promise<T>;
}

function buildRepoOps(db: Queryable): RepoOps {
  return {
    async insertEvents(rows) {
      if (rows.length === 0) return;
      await db.insert(events).values(rows).onConflictDoNothing({ target: events.id });
    },

    async getCursor(key) {
      const rows = await db
        .select({ value: cursors.value })
        .from(cursors)
        .where(eq(cursors.key, key))
        .limit(1);
      return rows[0]?.value ?? null;
    },

    async setCursor(key, value) {
      await db
        .insert(cursors)
        .values({ key, value })
        .onConflictDoUpdate({ target: cursors.key, set: { value, updatedAt: new Date() } });
    },

    async insertCtActivity(rows) {
      if (rows.length === 0) return;
      await db.insert(ctActivity).values(rows);
    },

    async insertBootnodePage(row) {
      await db.insert(bootnodePages).values(row).onConflictDoNothing({ target: bootnodePages.cursorIn });
    },

    async getBootnodePage(cursorIn) {
      const rows = await db
        .select()
        .from(bootnodePages)
        .where(eq(bootnodePages.cursorIn, cursorIn))
        .limit(1);
      return rows[0] ?? null;
    },

    async listEventsFromLedger({ contractIds, fromLedger, toLedger, limit }) {
      const conditions = [inArray(events.contractId, contractIds), gte(events.ledger, fromLedger)];
      if (toLedger !== undefined) conditions.push(lte(events.ledger, toLedger));
      return db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(asc(events.ledger), asc(events.txIndex), asc(events.opIndex), asc(events.eventIndex))
        .limit(limit);
    },

    async listEventsAfterId({ contractIds, afterId, toLedger, limit }) {
      const cursorRow = await db
        .select({
          ledger: events.ledger,
          txIndex: events.txIndex,
          opIndex: events.opIndex,
          eventIndex: events.eventIndex,
        })
        .from(events)
        .where(and(eq(events.id, afterId), inArray(events.contractId, contractIds)))
        .limit(1);
      const cursor = cursorRow[0];
      if (cursor === undefined) return null;

      const conditions = [
        inArray(events.contractId, contractIds),
        sql`(${events.ledger}, ${events.txIndex}, ${events.opIndex}, ${events.eventIndex}) > (${cursor.ledger}, ${cursor.txIndex}, ${cursor.opIndex}, ${cursor.eventIndex})`,
      ];
      if (toLedger !== undefined) conditions.push(lte(events.ledger, toLedger));
      return db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(asc(events.ledger), asc(events.txIndex), asc(events.opIndex), asc(events.eventIndex))
        .limit(limit);
    },

    async getLedgerBounds(contractIds) {
      const rows = await db
        .select({
          min: sql<number | null>`min(${events.ledger})`,
          max: sql<number | null>`max(${events.ledger})`,
        })
        .from(events)
        .where(contractIds !== undefined ? inArray(events.contractId, contractIds) : undefined);
      const row = rows[0];
      if (row === undefined || row.min === null || row.max === null) return null;
      return { min: row.min, max: row.max };
    },

    async listActivityForAccount({ account, limit }) {
      return db
        .select()
        .from(ctActivity)
        .where(eq(ctActivity.account, account))
        .orderBy(desc(ctActivity.ledger), desc(ctActivity.id))
        .limit(limit);
    },

    async listActivityForAccountBeforeId({ account, beforeId, limit }) {
      const cursorRow = await db
        .select({ ledger: ctActivity.ledger, id: ctActivity.id })
        .from(ctActivity)
        .where(and(eq(ctActivity.id, beforeId), eq(ctActivity.account, account)))
        .limit(1);
      const cursor = cursorRow[0];
      if (cursor === undefined) return null;

      return db
        .select()
        .from(ctActivity)
        .where(
          and(
            eq(ctActivity.account, account),
            sql`(${ctActivity.ledger}, ${ctActivity.id}) < (${cursor.ledger}, ${cursor.id})`,
          ),
        )
        .orderBy(desc(ctActivity.ledger), desc(ctActivity.id))
        .limit(limit);
    },
  };
}

/** Build an `IndexerRepo` bound to a `createDb(...).db` handle. */
export function createRepo(db: Db): IndexerRepo {
  return {
    ...buildRepoOps(db),
    withTransaction(fn) {
      return db.transaction((tx) => fn(buildRepoOps(tx)));
    },
  };
}
