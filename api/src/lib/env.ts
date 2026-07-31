import { TESTNET } from "@grantfox/shared";
import { z } from "zod";

/**
 * Process env schema. `DATABASE_URL` is required everywhere this package
 * runs (worker, API server); `POLL_INTERVAL_MS` is consumed by the indexer
 * worker (Task 7) as its RPC/indexer poll cadence and defaults to 5s.
 * `RPC_URL`/`BOOTNODE_URL` are worker (Task 7) overrides for the two event
 * sources — both default to the `TESTNET` config so the worker runs against
 * public testnet infra out of the box, but can be pointed at e.g. a private
 * RPC or an alternate bootnode if the public one is down/cache-missing.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RPC_URL: z.string().min(1).default(TESTNET.rpcUrl),
  BOOTNODE_URL: z.string().min(1).default(TESTNET.spp.nethermindBootnode),
});

export type Env = z.infer<typeof envSchema>;

/** Parse + validate `process.env` (or a supplied source, for testing). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
