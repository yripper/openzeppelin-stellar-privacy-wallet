/**
 * REST routes: `/health`, `/contracts/:contractId/events`,
 * `/accounts/:address/activity`.
 *
 * `/health` and `/contracts/:contractId/events` deliberately MIRROR
 * `@ctd/indexer`'s handler API (read, not guessed:
 * `resources/stellar-confidential-token-demo/packages/indexer/handler/src/routes/events.ts:23-65`,
 * `.../routes/health.ts`, `.../db/queries.ts`) — same query params, same
 * response envelope, same default/max limit (200/1000), same "opaque
 * base64-of-last-id" cursor convention, same oldest->newest ordering — so
 * `@ctd/sdk`'s `IndexerClient` (`packages/ctd-sdk/src/chain/indexer.ts`)
 * can point its `baseUrl` at this server and its HTTP-level plumbing (URL
 * construction, the `cursor`-follow loop, `health()`) works unmodified. See
 * this task's report for the one place this does NOT extend to: content
 * decoding. `topic`/`value` here are the SAME base64-XDR strings our
 * `events` table already stores (this API has no Goldsky pipeline, unlike
 * the reference indexer) — `IndexerClient.parseIndexerEvent`
 * (`indexer.ts:186-202`) expects Goldsky's JSON-ScVal shape and will not
 * decode a `ConfidentialEvent` out of these rows; only the wire
 * envelope/URL/pagination contract is guaranteed compatible, not CT event
 * content decoding through that specific client path.
 *
 * `/accounts/:address/activity` has no external reference to mirror (it's
 * this repo's own `ct_activity` feed) — same conventions applied for
 * internal consistency (base64-of-last-id cursor, default/max limit),
 * ordered newest-first per the task-9 brief.
 *
 * Ordering note (shared with `db/repo.ts`'s Task 9 query methods): pages
 * are ordered by the REAL chain position `(ledger, txIndex, opIndex,
 * eventIndex)` — not string `id` order, which the reference indexer's
 * fixed-width Goldsky ids can rely on but our `${ledger}-${txHash}-${opIndex}-${eventIndex}`
 * ids (no zero-padding) cannot in general.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AccountActivityBeforeIdQuery, AccountActivityQuery, EventsAfterIdQuery, EventsWindowQuery, RepoOps } from "../../db/repo.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** The narrow slice of `RepoOps` these routes need. */
export type ActivityRepoDeps = Pick<
  RepoOps,
  "listEventsFromLedger" | "listEventsAfterId" | "getLedgerBounds" | "listActivityForAccount" | "listActivityForAccountBeforeId"
>;

interface ErrorResponse {
  error: { code: string; message: string };
}

function jsonError(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

/** Mirrors `queries.ts`'s `parseIntParam` — a present-but-non-integer/negative value throws; an absent one is `undefined`. */
function parseIntParam(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
  return parsed;
}

/** Mirrors `queries.ts`'s `clampLimit`: falsy/invalid -> DEFAULT_LIMIT, else capped at MAX_LIMIT. */
function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/** Opaque pagination cursor: base64 of the last row's id — same convention as `queries.ts`'s `encodeCursor`. */
function encodeCursor(lastId: string): string {
  return Buffer.from(lastId, "utf8").toString("base64");
}

/** Lenient decode (never throws) — an unresolvable result surfaces downstream as "the repo couldn't find this id", not a base64-format error, since malformed base64 and a stale/foreign id both need the same 400 response. */
function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64").toString("utf8");
}

/** `limit + 1`-row over-fetch -> `{page, cursor}` (trims the probe row, encodes its id as the next cursor). */
function paginate<T extends { id: string }>(rows: T[], limit: number): { page: T[]; cursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { page, cursor: hasMore && last !== undefined ? encodeCursor(last.id) : null };
}

function sendInvalidArgument(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send(jsonError("INVALID_ARGUMENT", message));
}

interface EventsQuerystring {
  startLedger?: string;
  endLedger?: string;
  cursor?: string;
  limit?: string;
}

interface ActivityQuerystring {
  cursor?: string;
  limit?: string;
}

export function registerActivityRoutes(app: FastifyInstance, repo: ActivityRepoDeps): void {
  app.get("/health", async (_request, reply) => {
    const bounds = await repo.getLedgerBounds();
    reply.send({ latest_synced_ledger: bounds?.max ?? 0 });
  });

  app.get<{ Params: { contractId: string }; Querystring: EventsQuerystring }>(
    "/contracts/:contractId/events",
    async (request, reply) => {
      const { contractId } = request.params;
      let startLedger: number | undefined;
      let endLedger: number | undefined;
      let limitParsed: number | undefined;
      try {
        startLedger = parseIntParam("startLedger", request.query.startLedger);
        endLedger = parseIntParam("endLedger", request.query.endLedger);
        limitParsed = parseIntParam("limit", request.query.limit);
      } catch (error) {
        return sendInvalidArgument(reply, error instanceof Error ? error.message : "Invalid query");
      }
      const limit = clampLimit(limitParsed);

      let rows;
      if (request.query.cursor !== undefined) {
        const query: EventsAfterIdQuery = {
          contractIds: [contractId],
          afterId: decodeCursor(request.query.cursor),
          toLedger: endLedger,
          limit: limit + 1,
        };
        const page = await repo.listEventsAfterId(query);
        if (page === null) return sendInvalidArgument(reply, "Invalid cursor");
        rows = page;
      } else {
        const query: EventsWindowQuery = { contractIds: [contractId], fromLedger: startLedger ?? 0, toLedger: endLedger, limit: limit + 1 };
        rows = await repo.listEventsFromLedger(query);
      }

      const { page, cursor } = paginate(rows, limit);
      const bounds = await repo.getLedgerBounds();
      reply.send({
        latestLedger: bounds?.max ?? 0,
        cursor,
        events: page.map((r) => ({ id: r.id, ledger: r.ledger, txHash: r.txHash, topic: r.topic, value: r.valueXdr })),
      });
    },
  );

  app.get<{ Params: { address: string }; Querystring: ActivityQuerystring }>(
    "/accounts/:address/activity",
    async (request, reply) => {
      const { address } = request.params;
      let limitParsed: number | undefined;
      try {
        limitParsed = parseIntParam("limit", request.query.limit);
      } catch (error) {
        return sendInvalidArgument(reply, error instanceof Error ? error.message : "Invalid query");
      }
      const limit = clampLimit(limitParsed);

      let rows;
      if (request.query.cursor !== undefined) {
        const query: AccountActivityBeforeIdQuery = { account: address, beforeId: decodeCursor(request.query.cursor), limit: limit + 1 };
        const page = await repo.listActivityForAccountBeforeId(query);
        if (page === null) return sendInvalidArgument(reply, "Invalid cursor");
        rows = page;
      } else {
        const query: AccountActivityQuery = { account: address, limit: limit + 1 };
        rows = await repo.listActivityForAccount(query);
      }

      const { page, cursor } = paginate(rows, limit);
      reply.send({
        cursor,
        activity: page.map((r) => ({
          id: r.id,
          account: r.account,
          type: r.type,
          counterparty: r.counterparty,
          amount: r.amount,
          ledger: r.ledger,
          txHash: r.txHash,
          eventId: r.eventId,
          ciphertexts: r.ciphertexts,
        })),
      });
    },
  );
}
