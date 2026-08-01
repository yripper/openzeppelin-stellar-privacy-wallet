/**
 * Task 8.5: fetch the complete SPP contract event history from
 * stellar.expert's public archive (the only remaining source — see
 * `src/lib/spp-archive.ts`'s module doc for why both live sources, the RPC
 * and Nethermind's bootnode, are dead for this history), resolve each
 * event's `txHash` via Horizon testnet, map to `RawEvent` rows, and write a
 * deterministic, committed fixture (`api/fixtures/spp-backfill.json`).
 *
 * Usage: `pnpm --filter @grantfox/api exec tsx scripts/backfill-spp.ts`
 * Idempotent: re-running refreshes the fixture to whatever is on-chain "to
 * tip at run time" (the brief's wording) — safe to re-run periodically until
 * Task 9's own bootnode (serving from OUR events table) makes this recovery
 * path unnecessary.
 *
 * Network I/O only — no DB access here (that's `load-backfill.ts`). Pure
 * decode/mapping logic lives in `src/lib/spp-archive.ts` (unit tested); the
 * stellar.expert/Horizon adapters live in `src/lib/spp-archive-client.ts`
 * (not unit tested against a live network, per the brief — exercised by
 * actually running this script).
 */
import { TESTNET } from "@grantfox/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawEvent } from "../src/lib/soroban-events.js";
import { fetchAllArchiveEvents, resolveTxHash, sleep } from "../src/lib/spp-archive-client.js";
import { compareArchiveOrder, mapArchiveRecordToRawEvent, toidFromArchiveId } from "../src/lib/spp-archive.js";

const STELLAR_EXPERT_BASE = "https://api.stellar.expert/explorer/testnet";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
/** Politeness delay after any call that actually hit the network (not on cache hits) — task-8.5 brief: "sequential requests, modest limits, no hammering." */
const POLITE_DELAY_MS = 300;

/**
 * The SDK's full sync set — `all_contract_ids()` = enabled pools +
 * asp_membership + public_key_registry
 * (`resources/stellar-private-payments/sdk/types/src/lib.rs:323-329`),
 * cross-checked against the vendored deployment manifest
 * (`resources/stellar-private-payments/deployments/testnet/deployments.json`,
 * both pools `"enabled": true`) — exactly the 4 contracts the task-8.5 brief
 * lists. At the time this script was written, only THREE of these lived in
 * `packages/shared/src/config.ts` (`TESTNET.spp.pool` / `.aspMembership` /
 * `.publicKeyRegistry`) — the EURC pool was flagged as a `config.ts` gap in
 * the task-8.5 report rather than silently "fixed" here as an out-of-scope
 * side effect. Task 9 closed that gap (`TESTNET.spp.poolEurc`, now consumed
 * by `worker.ts`'s live SPP stream and the bootnode handler's allow-list)
 * but deliberately left this script's own hardcode as-is (per the task-9
 * brief: "Task 8.5's script may keep its hardcode") — this is a one-shot
 * archival-recovery script, not a live code path, so there is no drift risk
 * worth the touch. The value below is identical to `TESTNET.spp.poolEurc`.
 */
const POOL_EURC_CONTRACT_ID = "CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74";

const CONTRACTS: ReadonlyArray<{ name: string; id: string }> = [
  { name: "pool", id: TESTNET.spp.pool },
  { name: "pool_eurc", id: POOL_EURC_CONTRACT_ID },
  { name: "asp_membership", id: TESTNET.spp.aspMembership },
  { name: "public_key_registry", id: TESTNET.spp.publicKeyRegistry },
];

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/spp-backfill.json", import.meta.url));

/** `RawEvent` with `ledgerClosedAt` as an ISO string — JSON-safe, same convention as `__fixtures__/ct-events.json`. */
interface FixtureEventRow extends Omit<RawEvent, "ledgerClosedAt"> {
  ledgerClosedAt: string;
}

interface Fixture {
  generatedAt: string;
  source: { archive: string; horizon: string };
  contracts: Array<{ name: string; id: string; eventCount: number }>;
  events: FixtureEventRow[];
}

function serializeRow(e: RawEvent): FixtureEventRow {
  return { ...e, ledgerClosedAt: e.ledgerClosedAt.toISOString() };
}

async function main(): Promise<void> {
  const txHashCache = new Map<string, string>();
  const allRows: RawEvent[] = [];
  const perContract: Array<{ name: string; id: string; eventCount: number }> = [];

  for (const contract of CONTRACTS) {
    console.log(`[backfill-spp] fetching ${contract.name} (${contract.id})...`);
    const records = await fetchAllArchiveEvents(STELLAR_EXPERT_BASE, contract.id, { politeDelayMs: POLITE_DELAY_MS });
    perContract.push({ name: contract.name, id: contract.id, eventCount: records.length });
    console.log(`[backfill-spp]   ${records.length} events`);

    for (const record of records) {
      const toid = toidFromArchiveId(record.id);
      const beforeCacheSize = txHashCache.size;
      const txHash = await resolveTxHash(HORIZON_URL, toid, txHashCache);
      allRows.push(mapArchiveRecordToRawEvent(record, txHash));
      if (txHashCache.size > beforeCacheSize) {
        // Actually hit the network (cache miss) — be polite before the next one.
        await sleep(POLITE_DELAY_MS);
      }
    }

    await sleep(POLITE_DELAY_MS);
  }

  allRows.sort(compareArchiveOrder);

  const fixture: Fixture = {
    generatedAt: new Date().toISOString(),
    source: {
      archive: `${STELLAR_EXPERT_BASE}/contract/<contractId>/events`,
      horizon: `${HORIZON_URL}/transactions`,
    },
    contracts: perContract,
    events: allRows.map(serializeRow),
  };

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

  console.log(`[backfill-spp] wrote ${allRows.length} events total to ${FIXTURE_PATH}`);
  for (const c of perContract) {
    console.log(`[backfill-spp]   ${c.name} (${c.id}): ${c.eventCount}`);
  }
}

main().catch((err) => {
  console.error("[backfill-spp] fatal error", err);
  process.exit(1);
});
