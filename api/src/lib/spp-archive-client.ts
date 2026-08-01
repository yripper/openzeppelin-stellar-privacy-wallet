/**
 * I/O adapters for Task 8.5's SPP historical backfill — pure network calls,
 * no DB access, injectable `fetch` for tests (same convention as
 * `soroban-events.ts`/`bootnode-client.ts`). NOT unit tested against a live
 * network (per the task brief: "Live fetch NOT in unit tests") — only
 * `spp-archive.ts`'s pure decode/mapping logic is unit tested; this module
 * is exercised by actually running `api/scripts/backfill-spp.ts`.
 *
 * Two sources:
 * - stellar.expert's public explorer API (`fetchArchiveEventsPage`) — the
 *   archive of SPP contract events, since both live sources (RPC retention,
 *   Nethermind's bootnode) are dead for this history (see `spp-archive.ts`'s
 *   module doc).
 * - Horizon testnet (`resolveTxHash`) — archive records carry no `txHash`,
 *   only a TOID; Horizon resolves TOID -> tx hash. Cached by the caller
 *   (many events share one transaction) via the `cache` param.
 *
 * Politeness (task-8.5 brief, "3rd-party courtesy: stellar.expert is a free
 * community API"): sequential requests only (this module makes no concurrent
 * calls), retried on 429/5xx with the SAME exponential backoff the worker
 * already uses for stream failures (`backoffDelayMs`, imported from
 * `worker.ts` rather than re-implementing the formula), capped retries so a
 * persistently-down endpoint fails loudly instead of looping forever.
 */
import { backoffDelayMs } from "../worker.js";
import { txToidForEvent, type ArchiveEventRecord } from "./spp-archive.js";

const MAX_RETRIES = 6;

/** Exported so `backfill-spp.ts` can apply the same politeness delay around its own Horizon calls (only when `resolveTxHash` actually hit the network, not on a cache hit). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET `url`, retrying on 429/5xx AND on a thrown network-level error (DNS
 * failure, connection reset, timeout — `fetch` rejects rather than
 * resolving for these, so they never reach the `res.ok` check) with
 * `backoffDelayMs`'s exponential schedule (1s -> 60s cap), up to
 * `MAX_RETRIES` times. Throws on any other non-OK status, or after
 * exhausting retries. The network-error branch was added after a live
 * backfill run hit a mid-run `ECONNRESET` against a free third-party API —
 * without it, one transient blip anywhere in a run touching hundreds of
 * events would abort the whole script with no partial progress saved (the
 * fixture is only written at the very end).
 */
async function fetchJsonWithRetry(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`fetchJsonWithRetry: ${url} failed after ${attempt + 1} attempts: ${String(err)}`, { cause: err });
      }
      const delay = backoffDelayMs(attempt + 1);
      console.error(
        `[spp-archive-client] ${url} -> network error (${String(err)}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      continue;
    }
    if (res.ok) return res.json();

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`fetchJsonWithRetry: ${url} failed with ${res.status} ${res.statusText} (attempt ${attempt + 1})`);
    }
    const delay = backoffDelayMs(attempt + 1);
    console.error(`[spp-archive-client] ${url} -> ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
  }
}

export interface ArchiveEventsPageResult {
  records: ArchiveEventRecord[];
  /** The last record's `id` in this page — pass as `cursor` for the next page. `null` when the page was short (fewer than `limit` records), signaling no more data. */
  nextCursor: string | null;
}

export interface FetchArchiveEventsPageOptions {
  cursor?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}

/** One page of `GET /explorer/testnet/contract/<contractId>/events?order=asc&limit=<n>[&cursor=...]` — see `spp-archive.ts`'s module doc for the verified record shape. */
export async function fetchArchiveEventsPage(
  baseUrl: string,
  contractId: string,
  opts: FetchArchiveEventsPageOptions = {},
): Promise<ArchiveEventsPageResult> {
  const { cursor, limit = 200, fetchImpl = fetch } = opts;
  const params = new URLSearchParams({ order: "asc", limit: String(limit) });
  if (cursor !== undefined) params.set("cursor", cursor);
  const url = `${baseUrl}/contract/${contractId}/events?${params.toString()}`;

  const json = (await fetchJsonWithRetry(url, fetchImpl)) as {
    _embedded?: { records?: ArchiveEventRecord[] };
  };
  const records = json._embedded?.records ?? [];
  const nextCursor = records.length === limit ? (records[records.length - 1]?.id ?? null) : null;
  return { records, nextCursor };
}

/** Fetch EVERY event for one contract, oldest-first, paginating politely (sequential, `politeDelayMs` between page requests). */
export async function fetchAllArchiveEvents(
  baseUrl: string,
  contractId: string,
  opts: { limit?: number; politeDelayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ArchiveEventRecord[]> {
  const { limit = 200, politeDelayMs = 300, fetchImpl } = opts;
  const all: ArchiveEventRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchArchiveEventsPage(baseUrl, contractId, { cursor, limit, fetchImpl });
    all.push(...page.records);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    await sleep(politeDelayMs);
  }
  return all;
}

interface HorizonTransactionRecord {
  hash: string;
  paging_token: string;
}

/**
 * Resolve the `txHash` for an event's TOID via Horizon testnet, caching by
 * the transaction-level TOID (many events share one tx) — see
 * `spp-archive.ts`'s module doc for why `txToidForEvent` (not the raw event
 * TOID) is the correct cursor base, refining the brief's literal recipe.
 * Verifies the returned transaction's own `paging_token` matches the
 * expected tx-level TOID exactly (the brief's "paging_token's TOID prefix
 * matches" check) — throws rather than silently trusting a mismatched tx.
 */
export async function resolveTxHash(
  horizonUrl: string,
  eventToid: bigint,
  cache: Map<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const txToid = txToidForEvent(eventToid);
  const key = txToid.toString();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const cursor = (txToid - 1n).toString();
  const url = `${horizonUrl}/transactions?cursor=${cursor}&limit=1&order=asc`;
  const json = (await fetchJsonWithRetry(url, fetchImpl)) as {
    _embedded?: { records?: HorizonTransactionRecord[] };
  };
  const record = json._embedded?.records?.[0];
  if (record === undefined) {
    throw new Error(`resolveTxHash: Horizon returned no transaction for event toid ${eventToid} (cursor ${cursor})`);
  }
  if (record.paging_token !== key) {
    throw new Error(
      `resolveTxHash: Horizon transaction paging_token ${record.paging_token} does not match the expected tx-level toid ${key} for event toid ${eventToid} — resolution assumption may be wrong, see spp-archive.ts's module doc`,
    );
  }
  cache.set(key, record.hash);
  return record.hash;
}
