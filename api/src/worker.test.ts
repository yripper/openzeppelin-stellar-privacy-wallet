/**
 * Unit tests for the worker loop's pure/testable pieces (Task 7):
 * exponential-backoff arithmetic and the per-tick scheduling that skips a
 * backing-off stream while a healthy stream keeps polling every tick — the
 * layer `pollStreams` (`api/src/modules/indexer/poller.ts`, invariant 5)
 * sits under. Process lifecycle (`main`: env load, signal handling,
 * `pool.end()`) is intentionally NOT unit-tested here — it's exercised by
 * the bounded live-verification run instead (see task-7-report.md).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IndexerRepo, RepoOps } from "./db/repo.js";
import type { NewCtActivityRow } from "./db/schema.js";
import type { RawEvent } from "./lib/soroban-events.js";
import type { StreamSource } from "./modules/indexer/poller.js";
import {
  backoffDelayMs,
  buildInitialStreamState,
  buildSppContractIds,
  buildSppStreamKey,
  tick,
  type StreamRuntimeState,
} from "./worker.js";

/** Minimal in-memory `IndexerRepo` — enough for `tick`/`pollStreams` to run against; no rollback semantics needed here (that's covered in `poller.test.ts`). */
class FakeRepo implements IndexerRepo {
  private cursors = new Map<string, string>();
  private eventCounter = 0;
  private ctActivity: NewCtActivityRow[] = [];

  async insertEvents(rows: unknown[]): Promise<void> {
    this.eventCounter += rows.length;
  }
  async getCursor(key: string): Promise<string | null> {
    return this.cursors.get(key) ?? null;
  }
  async setCursor(key: string, value: string): Promise<void> {
    this.cursors.set(key, value);
  }
  async insertCtActivity(rows: NewCtActivityRow[]): Promise<void> {
    this.ctActivity.push(...rows);
  }
  async insertBootnodePage(): Promise<void> {}
  async getBootnodePage(): Promise<null> {
    return null;
  }
  async withTransaction<T>(fn: (repo: RepoOps) => Promise<T>): Promise<T> {
    return fn(this);
  }
  get eventCount(): number {
    return this.eventCounter;
  }
  get ctActivityRows(): NewCtActivityRow[] {
    return [...this.ctActivity];
  }
}

const CT_TOKEN_ID = "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH";

/** Same live-testnet fixture `normalize-ct.test.ts`/`poller.test.ts` use — see `normalize-ct.test.ts`'s module doc for provenance. */
function loadCtRegisterFixture(): RawEvent {
  const path = fileURLToPath(new URL("./modules/indexer/__fixtures__/ct-events.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<
    Omit<RawEvent, "ledgerClosedAt"> & { ledgerClosedAt: string }
  >;
  const registerFixture = raw[4]; // a real `register` event
  if (registerFixture === undefined) throw new Error("ct fixture 4 missing");
  return { ...registerFixture, ledgerClosedAt: new Date(registerFixture.ledgerClosedAt) };
}

describe("buildSppContractIds / buildSppStreamKey", () => {
  it("returns the SDK's full 5-contract sync set: pool, poolLegacy, poolEurc, aspMembership, publicKeyRegistry", () => {
    expect(buildSppContractIds()).toEqual([
      "CC3AVJZR5MSOLLNNP7DYSG3KR7MTBE4N4VMAT5ZX4NWIJTQL75RNI3F5",
      "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
      "CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74",
      "CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K",
      "CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36",
    ]);
  });

  it("buildSppStreamKey defaults to buildSppContractIds(), joined with a spp: prefix", () => {
    expect(buildSppStreamKey()).toBe(`spp:${buildSppContractIds().join(",")}`);
    expect(buildSppStreamKey(["A", "B"])).toBe("spp:A,B");
  });
});

describe("backoffDelayMs", () => {
  it.each([
    [0, 0],
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 16000],
    [6, 32000],
    [7, 60000],
    [10, 60000],
  ])("consecutiveFailures=%i -> %ims (1s base, 60s cap)", (failures, expected) => {
    expect(backoffDelayMs(failures)).toBe(expected);
  });
});

describe("tick", () => {
  it("isolates a backing-off stream from a healthy one, and retries it once its backoff window elapses", async () => {
    const repo = new FakeRepo();
    let now = 1_000_000;
    const failingCalls: Array<string | null> = [];
    const okCalls: Array<string | null> = [];
    const failingSource: StreamSource = {
      fetchPage: async (cursor) => {
        failingCalls.push(cursor);
        throw new Error("boom");
      },
    };
    const okSource: StreamSource = {
      fetchPage: async (cursor) => {
        okCalls.push(cursor);
        return { events: [], nextCursor: "ok-cursor" };
      },
    };
    const states: StreamRuntimeState[] = [
      buildInitialStreamState("failing", failingSource),
      buildInitialStreamState("ok", okSource),
    ];

    await tick(states, repo, now);
    expect(failingCalls).toHaveLength(1);
    expect(okCalls).toHaveLength(1);
    const failingState = states.find((s) => s.streamKey === "failing")!;
    expect(failingState.consecutiveFailures).toBe(1);
    expect(failingState.nextAttemptAt).toBe(now + 1000);

    // 500ms later: still inside the 1s backoff window — failing stream skipped, ok stream keeps going.
    now += 500;
    await tick(states, repo, now);
    expect(failingCalls).toHaveLength(1);
    expect(okCalls).toHaveLength(2);

    // Past the 1s window (total 1100ms since the first failure): retried, and fails again -> backoff doubles.
    now += 600;
    await tick(states, repo, now);
    expect(failingCalls).toHaveLength(2);
    expect(failingState.consecutiveFailures).toBe(2);
    expect(failingState.nextAttemptAt).toBe(now + 2000);
  });

  it("resets a stream's backoff to zero after it succeeds again", async () => {
    const repo = new FakeRepo();
    let now = 0;
    let shouldFail = true;
    const source: StreamSource = {
      fetchPage: async () => {
        if (shouldFail) throw new Error("boom");
        return { events: [], nextCursor: "c" };
      },
    };
    const states: StreamRuntimeState[] = [buildInitialStreamState("flaky", source)];

    await tick(states, repo, now);
    expect(states[0]!.consecutiveFailures).toBe(1);

    shouldFail = false;
    now += 1000;
    await tick(states, repo, now);
    expect(states[0]!.consecutiveFailures).toBe(0);
    expect(states[0]!.nextAttemptAt).toBe(now);
  });

  it("forwards shouldStop to pollStreams, cutting the tick short between streams (review fix)", async () => {
    const repo = new FakeRepo();
    const calls: string[] = [];
    const firstSource: StreamSource = {
      fetchPage: async () => {
        calls.push("first");
        return { events: [], nextCursor: "c1" };
      },
    };
    const secondSource: StreamSource = {
      fetchPage: async () => {
        calls.push("second");
        return { events: [], nextCursor: "c2" };
      },
    };
    const states: StreamRuntimeState[] = [
      buildInitialStreamState("first", firstSource),
      buildInitialStreamState("second", secondSource),
    ];

    await tick(states, repo, 0, () => true); // already "shutting down" before the tick even starts

    expect(calls).toEqual([]); // neither stream was attempted
    // Untouched backoff state — a stream skipped by a shutdown signal isn't a failure.
    expect(states[0]!.consecutiveFailures).toBe(0);
    expect(states[1]!.consecutiveFailures).toBe(0);
  });

  it("forwards a stream's ctTokenId through to pollStream's CT normalization (Task 8 wiring)", async () => {
    const repo = new FakeRepo();
    const registerEvent = loadCtRegisterFixture();
    const ctSource: StreamSource = {
      fetchPage: async () => ({ events: [registerEvent], nextCursor: "ct-cursor" }),
    };
    const sppSource: StreamSource = {
      // Same real, normalizable event — but the SPP stream's state carries no
      // ctTokenId, so it must never be normalized regardless of its content.
      fetchPage: async () => ({ events: [registerEvent], nextCursor: "spp-cursor" }),
    };
    const states: StreamRuntimeState[] = [
      buildInitialStreamState("ct:test", ctSource, CT_TOKEN_ID),
      buildInitialStreamState("spp:test", sppSource),
    ];

    await tick(states, repo, 0);

    expect(repo.eventCount).toBe(2);
    expect(repo.ctActivityRows).toEqual([
      {
        account: "CB3I3Y5QD45DT4WHIRLTPLSEQSWKFFTGYYX5DDSDBXJALA4CP7CDB2WM",
        type: "register",
        counterparty: "CB3I3Y5QD45DT4WHIRLTPLSEQSWKFFTGYYX5DDSDBXJALA4CP7CDB2WM",
        amount: null,
        ledger: registerEvent.ledger,
        txHash: registerEvent.txHash,
        eventId: registerEvent.id,
        ciphertexts: {},
      },
    ]);
  });
});
