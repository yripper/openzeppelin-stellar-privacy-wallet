import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  bootnodePages,
  ctActivity,
  cursors,
  events,
  type BootnodePageRow,
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
