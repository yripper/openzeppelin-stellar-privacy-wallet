import { z } from "zod";

/**
 * Process env schema. `DATABASE_URL` is required everywhere this package
 * runs (worker, API server); `POLL_INTERVAL_MS` is consumed by the indexer
 * worker (Task 7) as its RPC/indexer poll cadence and defaults to 5s.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
});

export type Env = z.infer<typeof envSchema>;

/** Parse + validate `process.env` (or a supplied source, for testing). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
