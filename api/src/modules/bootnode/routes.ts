/**
 * JSON-RPC 2.0 transport for the bootnode protocol — `POST /rpc` (the
 * task-9 brief's chosen path; the reference bootnode itself mounts this at
 * `POST /`, see `tools/bootnode/src/http_server.rs:63-68` — a naming choice
 * this repo controls, not part of the wire protocol the SDK's client
 * validates). Dispatches `getEvents`/`getLatestLedger` to `handler.ts`'s
 * pure business logic and wraps its typed `RpcOutcome` in the JSON-RPC 2.0
 * envelope (`{jsonrpc, id, result}` / `{jsonrpc, id, error}`).
 *
 * Batch requests are intentionally unsupported (matching the reference's
 * `BatchRequestConfig::Disabled`, `http_server.rs:51`) and no other
 * JSON-RPC method is exposed — the SDK's bootnode client only ever calls
 * these two (`sdk/stellar/src/rpc.rs:392-441`). JSON-RPC errors are
 * returned with HTTP 200 (per the JSON-RPC 2.0 convention and the SDK's own
 * `bootnode-client.ts` adapter, which parses `json.error` without first
 * checking `res.ok`); only a malformed request body (not JSON-RPC shaped at
 * all) gets `-32600`.
 */
import type { FastifyInstance } from "fastify";
import {
  INTERNAL_ERROR_CODE,
  handleGetEvents,
  handleGetLatestLedger,
  type BootnodeHandlerDeps,
  type JsonRpcError,
} from "./handler.js";

const INVALID_REQUEST_CODE = -32_600;
const METHOD_NOT_FOUND_CODE = -32_601;

interface JsonRpcRequestBody {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isValidId(id: unknown): id is string | number | null {
  return typeof id === "string" || typeof id === "number" || id === null;
}

export function registerBootnodeRoutes(app: FastifyInstance, deps: BootnodeHandlerDeps): void {
  app.post("/rpc", async (request, reply) => {
    const body = request.body as JsonRpcRequestBody | null;
    const id = isValidId(body?.id) ? body.id : null;

    const sendResult = (result: unknown) => reply.send({ jsonrpc: "2.0", id, result });
    const sendError = (error: JsonRpcError) => reply.send({ jsonrpc: "2.0", id, error });

    if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.method !== "string") {
      return sendError({ code: INVALID_REQUEST_CODE, message: "Invalid Request" });
    }

    try {
      switch (body.method) {
        case "getLatestLedger": {
          const outcome = await handleGetLatestLedger(deps);
          return outcome.ok ? sendResult(outcome.result) : sendError(outcome.error);
        }
        case "getEvents": {
          const outcome = await handleGetEvents(body.params, deps);
          return outcome.ok ? sendResult(outcome.result) : sendError(outcome.error);
        }
        default:
          return sendError({ code: METHOD_NOT_FOUND_CODE, message: `method not found: ${body.method}` });
      }
    } catch (error) {
      // Log the real error (DB/pg/undici internals, stack included) server-side
      // only — this is a publicly-advertised endpoint, so the wire response
      // never echoes `error.message` back to the caller (review fix).
      request.log.error({ err: error }, "[bootnode] unexpected error handling JSON-RPC request");
      return sendError({ code: INTERNAL_ERROR_CODE, message: "internal error" });
    }
  });
}
