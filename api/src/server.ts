/**
 * API server entrypoint (Task 9). Thin process-lifecycle shell around
 * `buildApp` (`app.ts`) — `loadEnv`, `createDb`/`createRepo`, `listen`,
 * clean shutdown on SIGINT/SIGTERM (closing the Fastify server before the
 * Postgres pool, mirroring `worker.ts`'s `main()` shutdown ordering).
 *
 * The bootnode endpoint's allow-list is `buildSppContractIds()`
 * (`worker.ts`, Task 9) — the SAME 4-contract SPP set the worker's SPP
 * stream now follows, so what the worker ingests and what this server
 * allow-lists can never drift apart.
 */
import { pathToFileURL } from "node:url";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { createRepo } from "./db/repo.js";
import { loadEnv } from "./lib/env.js";
import { buildSppContractIds } from "./worker.js";

export async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const repo = createRepo(db);

  const app = buildApp({
    repo,
    allowedContractIds: buildSppContractIds(),
    rpcUrl: env.RPC_URL,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`[server] received ${signal}, shutting down`);
    await app.close();
    await pool.end();
    app.log.info("[server] shut down cleanly");
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[server] fatal error", err);
    process.exit(1);
  });
}
