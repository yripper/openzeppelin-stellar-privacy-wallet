/**
 * Live proxy for the upstream Soroban RPC's `getLatestLedger` — one raw
 * JSON-RPC 2.0 POST, no `@stellar/stellar-sdk` involved. Two Task 9 call
 * sites need this: the bootnode-protocol `getLatestLedger` method itself
 * (the brief: "proxy upstream RPC live"), and the bootnode `getEvents`
 * response's `latestLedger`/`latestLedgerCloseTime` fields (see
 * `modules/bootnode/handler.ts`'s module doc for why those must be the REAL
 * network tip, not our own indexed-events max — the SPP Rust SDK's indexer
 * (`resources/stellar-private-payments/sdk/stellar/src/indexer.rs:155`)
 * compares `progress_ledger >= latest_ledger` to decide "have I caught up
 * this round", so a wrong value there is a functional bug, not cosmetic).
 *
 * A raw POST (not `rpc.Server.getLatestLedger()`) is used deliberately:
 * `@stellar/stellar-sdk`'s parsed `Api.GetLatestLedgerResponse` types
 * `protocolVersion` as a `string` (`rpc/api.d.ts:47`), but the wire response
 * (verified live against `https://soroban-testnet.stellar.org`, 2026-08-01:
 * `{"id":"...","protocolVersion":27,"sequence":3914875,"closeTime":"..."}`)
 * sends it as a JSON NUMBER — matching the bootnode-protocol Rust structs
 * (`GetLatestLedgerResponse.protocol_version: u32`, both
 * `tools/bootnode/src/messages.rs:48-53` and `sdk/stellar/src/rpc.rs:76-81`,
 * IDENTICAL field set). A `u32` field fails to deserialize from a JSON
 * string, so passing through the SDK's own (possibly re-stringified) parsed
 * type would risk breaking the Rust client; reading the raw wire JSON
 * ourselves and forwarding `protocolVersion`/`sequence` as the numbers they
 * already are avoids that risk entirely. Same "pure adapter, injectable
 * `fetch`, `AbortController`+`setTimeout` bound" convention as
 * `bootnode-client.ts`.
 */
export interface UpstreamLatestLedger {
  id: string;
  protocolVersion: number;
  sequence: number;
  closeTime: string;
}

/** Mirrors `bootnode-client.ts`/`soroban-events.ts`'s shared default. */
const DEFAULT_TIMEOUT_MS = 30_000;

interface JsonRpcErrorPayload {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Fetch the upstream RPC's current `getLatestLedger` result. Throws a plain
 * `Error` on a non-OK HTTP response, a JSON-RPC error, a malformed/missing
 * required field, or a timeout — an ordinary rejected Promise, matching
 * `bootnode-client.ts`'s error-surfacing convention (no retry/backoff here;
 * callers own that policy).
 */
export async function fetchUpstreamLatestLedger(
  rpcUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<UpstreamLatestLedger> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = { jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`fetchUpstreamLatestLedger: request to ${rpcUrl} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`fetchUpstreamLatestLedger: upstream RPC ${rpcUrl} responded ${res.status}`);
  }

  const json = (await res.json()) as JsonRpcResponse;
  if (json.error) {
    throw new Error(`fetchUpstreamLatestLedger: JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }
  const result = json.result as Record<string, unknown> | undefined;
  if (result === undefined) {
    throw new Error("fetchUpstreamLatestLedger: response has neither result nor error");
  }

  const { id, protocolVersion, sequence, closeTime } = result;
  if (typeof id !== "string" || !isFiniteNumber(protocolVersion) || !isFiniteNumber(sequence) || typeof closeTime !== "string") {
    throw new Error(`fetchUpstreamLatestLedger: malformed result ${JSON.stringify(result)}`);
  }

  return { id, protocolVersion, sequence, closeTime };
}
