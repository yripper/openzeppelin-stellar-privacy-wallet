import { TESTNET } from "@privacy-wallet/shared";
import { z } from "zod";

/**
 * Process env schema. `DATABASE_URL` is required everywhere this package
 * runs (worker, API server); `POLL_INTERVAL_MS` is consumed by the indexer
 * worker (Task 7) as its RPC/indexer poll cadence and defaults to 5s.
 * `RPC_URL`/`BOOTNODE_URL` are worker (Task 7) overrides for the two event
 * sources — both default to the `TESTNET` config so the worker runs against
 * public testnet infra out of the box, but can be pointed at e.g. a private
 * RPC or an alternate bootnode if the public one is down/cache-missing.
 * `PORT` (Task 9) is the API server's listen port, default `3000`. The API
 * server (`server.ts`) also reads `RPC_URL` — same variable, same
 * `TESTNET.rpcUrl` default — as the upstream it proxies for `getLatestLedger`
 * and the `getEvents` bootnode handler's `latestLedger`/`latestLedgerCloseTime`
 * fields (see `modules/bootnode/handler.ts`'s module doc): one env var,
 * shared by both processes, rather than a second server-only RPC override
 * with no reason to ever differ from the worker's.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RPC_URL: z.string().min(1).default(TESTNET.rpcUrl),
  BOOTNODE_URL: z.string().min(1).default(TESTNET.spp.nethermindBootnode),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof envSchema>;

/** Parse + validate `process.env` (or a supplied source, for testing). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
