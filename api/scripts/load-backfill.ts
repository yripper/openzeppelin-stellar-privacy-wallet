/**
 * Task 8.5: load the committed SPP backfill fixture (`backfill-spp.ts`'s
 * output) into `events` (idempotent, on-conflict-do-nothing) and initialize
 * the SPP stream's cursor to RPC mode — so the worker's next poll for that
 * stream NEVER calls Nethermind's dead bootnode. See
 * `src/lib/spp-backfill-loader.ts`'s module doc for `SPP_STREAM_KEY`'s
 * replication caveat and the cursor-mode decision table.
 *
 * Usage: `DATABASE_URL=... pnpm --filter @grantfox/api exec tsx scripts/load-backfill.ts [fixturePath]`
 * (defaults to `api/fixtures/spp-backfill.json`).
 */
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/db/client.js";
import { createRepo } from "../src/db/repo.js";
import { events, type NewEventRow } from "../src/db/schema.js";
import { loadEnv } from "../src/lib/env.js";
import type { RawEvent } from "../src/lib/soroban-events.js";
import { initSppCursor, loadBackfillEvents, SPP_STREAM_KEY } from "../src/lib/spp-backfill-loader.js";

const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL("../fixtures/spp-backfill.json", import.meta.url));

interface FixtureEventRow extends Omit<RawEvent, "ledgerClosedAt"> {
  ledgerClosedAt: string;
}

interface Fixture {
  generatedAt: string;
  contracts: Array<{ name: string; id: string; eventCount: number }>;
  events: FixtureEventRow[];
}

function toNewEventRow(e: FixtureEventRow): NewEventRow {
  return { ...e, ledgerClosedAt: new Date(e.ledgerClosedAt) };
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2] ?? DEFAULT_FIXTURE_PATH;
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
  console.log(
    `[load-backfill] loaded fixture ${fixturePath}: ${fixture.events.length} events, generated ${fixture.generatedAt}`,
  );

  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const repo = createRepo(db);

  try {
    const rows = fixture.events.map(toNewEventRow);
    const submitted = await loadBackfillEvents(repo, rows);
    console.log(`[load-backfill] submitted ${submitted} rows to insertEvents (on-conflict-do-nothing by id)`);

    if (rows.length === 0) {
      console.log("[load-backfill] fixture has zero events — skipping cursor init (nothing to resume past)");
    } else {
      const lastBackfilledLedger = Math.max(...rows.map((r) => r.ledger));
      const result = await initSppCursor(repo, SPP_STREAM_KEY, lastBackfilledLedger);
      console.log(
        `[load-backfill] spp cursor ("${SPP_STREAM_KEY}"): ${result.initialized ? "initialized" : "left untouched"} (${result.reason}) -> ${result.cursor}`,
      );
    }

    // Real per-contract counts, read back from the DB itself — not just
    // "rows submitted" (which double-counts across idempotent re-runs).
    for (const c of fixture.contracts) {
      const rows_ = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(eq(events.contractId, c.id));
      const count = rows_[0]?.count ?? 0;
      console.log(`[load-backfill]   ${c.name} (${c.id}): ${count} rows now in events`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[load-backfill] fatal error", err);
  process.exit(1);
});
