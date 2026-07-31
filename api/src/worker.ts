/**
 * Indexer worker entrypoint (Task 7). Owns process lifecycle for the two
 * streams (CT + SPP): builds the `IndexerRepo`/sources, runs a poll loop on
 * `POLL_INTERVAL_MS`, exits cleanly on SIGINT/SIGTERM, and applies
 * per-stream exponential backoff (1s → 60s cap) on consecutive failures so
 * one misbehaving stream doesn't spam its source or starve the other.
 *
 * `tick`/`backoffDelayMs`/`buildInitialStreamState` are exported (and unit
 * tested in `worker.test.ts`) separately from `main` because they're pure
 * enough to test without a real DB, real network, or real signals; `main`
 * is the thin process-lifecycle shell around them.
 */
import { TESTNET } from "@grantfox/shared";
import { pathToFileURL } from "node:url";
import { createDb } from "./db/client.js";
import { createRepo, type IndexerRepo } from "./db/repo.js";
import { loadEnv } from "./lib/env.js";
import {
  makeBootnodeThenRpcSource,
  makeRpcSource,
  pollStreams,
  type StreamSource,
} from "./modules/indexer/poller.js";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/** `1s * 2^(failures-1)`, capped at 60s; `0` (no delay) when there have been no failures yet. */
export function backoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
}

export interface StreamRuntimeState {
  streamKey: string;
  source: StreamSource;
  consecutiveFailures: number;
  /** Epoch ms; the stream is skipped by `tick` until `now >= nextAttemptAt`. */
  nextAttemptAt: number;
}

export function buildInitialStreamState(streamKey: string, source: StreamSource): StreamRuntimeState {
  return { streamKey, source, consecutiveFailures: 0, nextAttemptAt: 0 };
}

/**
 * Attempt one page for every stream that's due (`nextAttemptAt <= now`),
 * isolating failures per stream via `pollStreams`. A failing stream's
 * `consecutiveFailures` increments and its next attempt is pushed out by
 * `backoffDelayMs`; a succeeding stream resets to zero and stays on the
 * normal cadence (the caller re-invokes `tick` every `POLL_INTERVAL_MS`).
 *
 * `shouldStop` is forwarded to `pollStreams` so `main`'s shutdown flag can
 * cut a multi-stream `tick` short between streams (not mid-flight — see
 * `pollStreams`'s doc) once network calls are timeout-bounded (review fix):
 * without a timeout, a hung fetch could block `tick` — and therefore the
 * `while` loop's `shuttingDown` check — indefinitely; with one, `tick`'s
 * worst case is bounded by the sum of in-flight-or-later streams' timeouts,
 * and `shouldStop` trims that to at most one.
 */
export async function tick(
  states: StreamRuntimeState[],
  repo: IndexerRepo,
  now: number = Date.now(),
  shouldStop?: () => boolean,
): Promise<void> {
  const due = states.filter((s) => now >= s.nextAttemptAt);
  if (due.length === 0) return;

  const outcomes = await pollStreams(
    due.map((s) => ({ streamKey: s.streamKey, source: s.source })),
    repo,
    shouldStop,
  );

  for (const outcome of outcomes) {
    const state = due.find((s) => s.streamKey === outcome.streamKey);
    if (state === undefined) continue; // unreachable: outcomes are 1:1 with `due`
    if (outcome.ok) {
      state.consecutiveFailures = 0;
      state.nextAttemptAt = now;
    } else {
      state.consecutiveFailures += 1;
      state.nextAttemptAt = now + backoffDelayMs(state.consecutiveFailures);
      console.error(
        `[worker] stream "${state.streamKey}" failed (consecutive failures: ${state.consecutiveFailures}, retrying in ${backoffDelayMs(state.consecutiveFailures)}ms):`,
        outcome.error,
      );
    }
  }
}

function buildStreamStates(env: { RPC_URL: string; BOOTNODE_URL: string }): StreamRuntimeState[] {
  const ctStreamKey = `ct:${TESTNET.ct.token}`;
  const ctSource = makeRpcSource({
    rpcUrl: env.RPC_URL,
    contractIds: [TESTNET.ct.token],
    startLedger: TESTNET.ct.deployedAtLedger,
  });

  const sppContractIds = [TESTNET.spp.pool, TESTNET.spp.publicKeyRegistry];
  const sppStreamKey = `spp:${sppContractIds.join(",")}`;
  const sppSource = makeBootnodeThenRpcSource({
    bootnodeUrl: env.BOOTNODE_URL,
    rpcUrl: env.RPC_URL,
    contractIds: sppContractIds,
    startLedger: TESTNET.spp.deploymentLedger,
  });

  return [buildInitialStreamState(ctStreamKey, ctSource), buildInitialStreamState(sppStreamKey, sppSource)];
}

/** Resolves once SIGINT or SIGTERM is received, with which one. */
function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  const repo = createRepo(db);
  const states = buildStreamStates(env);

  let shuttingDown = false;
  const shutdownPromise = waitForShutdownSignal();
  shutdownPromise.then((signal) => {
    console.log(`[worker] received ${signal}, shutting down after the current tick`);
    shuttingDown = true;
  });

  console.log(`[worker] starting — streams: ${states.map((s) => s.streamKey).join(", ")}`);

  while (!shuttingDown) {
    await tick(states, repo, Date.now(), () => shuttingDown);
    if (shuttingDown) break;

    // Sleep for POLL_INTERVAL_MS, but wake early on a shutdown signal
    // (`Promise.race`) — clear the timer either way so a stray handle
    // doesn't hold the process open past `pool.end()`.
    let timer: NodeJS.Timeout;
    const sleep = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, env.POLL_INTERVAL_MS);
    });
    await Promise.race([sleep, shutdownPromise]);
    clearTimeout(timer!);
  }

  await pool.end();
  console.log("[worker] shut down cleanly");
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[worker] fatal error", err);
    process.exit(1);
  });
}
