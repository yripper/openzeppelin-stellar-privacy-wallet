/**
 * Fastify app builder — assembles the REST routes (`modules/activity`) and
 * the bootnode JSON-RPC route (`modules/bootnode`) onto one `FastifyInstance`,
 * separated from `server.ts`'s `listen()`/process-lifecycle concerns so
 * tests can `app.inject()` without binding a real port (same "build vs.
 * listen" split `worker.ts` uses for `tick`/`main`).
 *
 * `AppDeps.repo` is typed as the READ-ONLY intersection the two route
 * modules actually use (`ActivityRepoDeps & BootnodeRepoDeps`), not the
 * full `IndexerRepo` — this server never writes to `events`/`ct_activity`/
 * `cursors` (only the worker, Task 7, does), so requiring `insertEvents`/
 * `withTransaction`/etc. here would overstate what this process needs. The
 * real `createRepo(db)` (`db/repo.ts`) satisfies this structurally with no
 * cast, since `IndexerRepo` is a superset.
 *
 * CORS (Task 11): the browser wallet (`@grantfox/app`) is the first consumer
 * that calls this API directly from a different origin (`http://localhost:5173`
 * dev, a deployed static-site origin in production) rather than
 * server-to-server/CLI. Registered permissively (`origin: true`, reflecting
 * the request's own `Origin`) because every route here is an unauthenticated
 * read of public, already-on-chain-derived data (raw events, normalized CT
 * activity, the bootnode-protocol proxy) — there is no session/cookie/secret
 * a stricter allow-list would be protecting.
 */
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ActivityRepoDeps } from "./modules/activity/routes.js";
import { registerActivityRoutes } from "./modules/activity/routes.js";
import type { BootnodeRepoDeps } from "./modules/bootnode/handler.js";
import { registerBootnodeRoutes } from "./modules/bootnode/routes.js";

export interface AppDeps {
  repo: ActivityRepoDeps & BootnodeRepoDeps;
  /** The SPP contract set the bootnode endpoint allow-lists — see `worker.ts`'s `buildSppContractIds`. */
  allowedContractIds: string[];
  /** Upstream Soroban RPC URL, proxied live by the bootnode endpoint (`getLatestLedger`, `getEvents`'s `latestLedger`). */
  rpcUrl: string;
  /** Forwarded to `Fastify({...})`; default `true`. Tests typically pass `false` to keep output clean. */
  logger?: FastifyServerOptions["logger"];
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  void app.register(cors, { origin: true });

  registerActivityRoutes(app, deps.repo);
  registerBootnodeRoutes(app, {
    repo: deps.repo,
    allowedContractIds: deps.allowedContractIds,
    rpcUrl: deps.rpcUrl,
  });

  return app;
}
