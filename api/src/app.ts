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
 */
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

  registerActivityRoutes(app, deps.repo);
  registerBootnodeRoutes(app, {
    repo: deps.repo,
    allowedContractIds: deps.allowedContractIds,
    rpcUrl: deps.rpcUrl,
  });

  return app;
}
