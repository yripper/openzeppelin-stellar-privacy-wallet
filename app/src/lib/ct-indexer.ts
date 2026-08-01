/**
 * XDR-decoding adapter over this repo's own REST API (`@grantfox/api`),
 * standing in for `@ctd/sdk`'s `IndexerClient` when talking to OUR indexer
 * instead of the reference Goldsky-backed one.
 *
 * `IndexerClient.fetchEvents`/`resolveEventRef` (as shipped) decode rows
 * assuming Goldsky's JSON-ScVal wire shape (`parseIndexerEvent`,
 * `packages/ctd-sdk/src/chain/indexer.ts:186-202`). Our API's `events` table
 * has no Goldsky pipeline — `topic`/`value` are base64-encoded XDR strings,
 * the exact same representation the RPC path produces. Pointed at our API
 * as-is, the base `IndexerClient` silently decodes ZERO events (no thrown
 * error) for every row, and if that empty stream reaches `StateEngine`, the
 * wallet's reconstructed balance is wrong with no error surfaced. Full
 * root-cause + the required fix shape: `docs/modules/api.md` §"Consuming CT
 * events from this API".
 *
 * The fix: decode our API's base64-XDR rows through the SAME field-mapping
 * single source of truth (`buildConfidentialEvent`) the RPC decoder
 * (`events.ts`'s private `parseEvent`) uses, so the two sources can never
 * silently drift apart on what a "register"/"deposit"/"transfer"/... event
 * means. This class SUBCLASSES `IndexerClient` (rather than duck-typing a
 * lookalike) purely so it satisfies `hybridFetchEvents`/
 * `hybridResolveEventRef`'s `indexer?: IndexerClient` parameter type exactly
 * — `fetchEvents`/`resolveEventRef` are fully overridden with our own HTTP +
 * XDR-decode implementation; the inherited (Goldsky-shaped) bodies are never
 * called.
 */
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  IndexerClient,
  KNOWN,
  buildConfidentialEvent,
  fromBytesBE,
  pointFromBytes,
  type ConfidentialEvent,
  type EventDataAccessor,
  type EventRef,
  type FetchEventsResult,
  type IndexerConfig,
} from "@ctd/sdk";

/** One row as returned by `GET /contracts/:contractId/events` (`api/src/modules/activity/routes.ts`). */
interface ApiEventRow {
  id: string;
  ledger: number;
  txHash: string;
  /** Each topic's XDR, base64-encoded (same wire form the RPC path produces). */
  topic: string[];
  /** The event's data `ScVal`, base64-XDR-encoded. */
  value: string;
}

interface ApiEventsPage {
  latestLedger: number;
  cursor: string | null;
  events: ApiEventRow[];
}

const DEFAULT_PAGE_LIMIT = 200;

/**
 * XDR-backed {@link EventDataAccessor} — mirrors `events.ts`'s private
 * `dataMap` byte-for-byte (that helper is not exported, so it is replicated
 * here rather than imported; see `events.ts:394-409`).
 */
function dataMap(value: xdr.ScVal): EventDataAccessor {
  const byName = new Map<string, xdr.ScVal>();
  for (const entry of value.map() ?? []) byName.set(entry.key().sym().toString(), entry.val());
  const get = (name: string): xdr.ScVal => {
    const v = byName.get(name);
    if (!v) throw new Error(`event data missing field "${name}"`);
    return v;
  };
  return {
    field: (name) => fromBytesBE(new Uint8Array(get(name).bytes())),
    point: (name) => pointFromBytes(new Uint8Array(get(name).bytes())),
    i128: (name) => scValToNative(get(name)) as bigint,
    u32: (name) => get(name).u32(),
  };
}

/**
 * Decode one API event row into a {@link ConfidentialEvent}, or `null` for an
 * unmapped event type. Mirrors `events.ts`'s private `parseEvent`, swapping
 * `rpc.Api.EventResponse` for our API's `{id, ledger, txHash, topic, value}`
 * row shape.
 */
export function parseApiEvent(row: ApiEventRow): ConfidentialEvent | null {
  if (row.topic.length === 0) return null;
  const topics = row.topic.map((t) => xdr.ScVal.fromXDR(t, "base64"));
  const nameVal = topics[0]!;
  if (nameVal.switch().name !== "scvSymbol") return null;
  const name = nameVal.sym().toString();
  if (!KNOWN.has(name)) return null;

  // Our API's row `id` is ALREADY @ctd/sdk's naturalEventId format
  // (`${ledger}-${txHash}-${opIndex}-${eventIndex}` — the schema's own doc
  // comment requires it, api/src/db/schema.ts:22-25: "Do not invent a
  // different id format here"), so it doubles as the source-independent
  // `cursor` directly — no need to re-derive opIndex/eventIndex from it.
  const base = { ledger: row.ledger, txHash: row.txHash, cursor: row.id };
  const addr = (i: number): string => Address.fromScVal(topics[i]!).toString();
  const value = xdr.ScVal.fromXDR(row.value, "base64");
  return buildConfidentialEvent(name, base, addr, dataMap(value));
}

export class ApiIndexerClient extends IndexerClient {
  #buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const u = new URL(path.replace(/^\//, ""), this.cfg.baseUrl.replace(/\/?$/, "/"));
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /**
   * Fetch and decode all token events in `[startLedger, endLedger]` (both
   * optional), following our API's cursor pagination to the end. Same
   * return shape as the base class so `hybridFetchEvents` merges it with the
   * RPC leg unmodified.
   */
  override async fetchEvents(opts: {
    contractId: string;
    startLedger?: number;
    endLedger?: number;
    pageLimit?: number;
  }): Promise<FetchEventsResult> {
    const limit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;
    const out: ConfidentialEvent[] = [];
    let cursor: string | undefined;
    let latestLedger = 0;

    for (;;) {
      const resp = await fetch(
        this.#buildUrl(`contracts/${opts.contractId}/events`, {
          startLedger: cursor ? undefined : opts.startLedger,
          endLedger: opts.endLedger,
          cursor,
          limit,
        }),
      );
      if (!resp.ok) {
        throw new Error(`ct-indexer: GET events ${resp.status}: ${(await safeText(resp)).slice(0, 200)}`);
      }
      const page = (await resp.json()) as ApiEventsPage;
      latestLedger = page.latestLedger ?? latestLedger;
      for (const row of page.events ?? []) {
        const ev = parseApiEvent(row);
        if (ev) out.push(ev);
      }
      if (!page.cursor || (page.events ?? []).length === 0) break;
      if (page.cursor === cursor) break; // defensive: no forward progress
      cursor = page.cursor;
    }

    return { events: out, cursor: undefined, latestLedger };
  }

  /** Resolve a single pinned event by reading only its ledger from our API. */
  override async resolveEventRef(contractId: string, ref: EventRef): Promise<ConfidentialEvent | null> {
    const resp = await fetch(
      this.#buildUrl(`contracts/${contractId}/events`, {
        startLedger: ref.ledger,
        endLedger: ref.ledger,
        limit: 200,
      }),
    );
    if (!resp.ok) return null;
    const page = (await resp.json()) as ApiEventsPage;
    const ev = (page.events ?? [])
      .map(parseApiEvent)
      .find((e): e is ConfidentialEvent => e !== null && e.cursor === ref.id);
    if (!ev) return null;
    if (ev.txHash !== ref.txHash) return null;
    return ev;
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

export type { IndexerConfig };
