/**
 * `spp-boundary-log.ts` — the local shield/unshield history the unified
 * Activity view reads (see the module's own doc for why this can't be read
 * back from chain/SDK state instead).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { listSppBoundaryEvents, recordSppBoundaryEvent } from "./spp-boundary-log.js";

const SESSION_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ3F";
const SESSION_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB6C4";

describe("spp-boundary-log", () => {
  beforeEach(async () => {
    // idb-keyval persists across tests in the same fake-indexeddb store;
    // start each case from an empty log for the addresses under test.
    const { clear } = await import("idb-keyval");
    await clear();
  });

  it("starts empty for a session that has never recorded anything", async () => {
    expect(await listSppBoundaryEvents(SESSION_A)).toEqual([]);
  });

  it("records a shield event with the exact amount and hashes handed to it", async () => {
    await recordSppBoundaryEvent(SESSION_A, { type: "shield", amount: "100000000", hashes: ["h1"] });
    const log = await listSppBoundaryEvents(SESSION_A);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: "shield", amount: "100000000", hashes: ["h1"] });
    expect(log[0]!.id).toBeTruthy();
    expect(log[0]!.createdAt).toBeTruthy();
  });

  it("orders newest first", async () => {
    await recordSppBoundaryEvent(SESSION_A, { type: "shield", amount: "1", hashes: [] });
    await recordSppBoundaryEvent(SESSION_A, { type: "unshield", amount: "2", hashes: [] });
    const log = await listSppBoundaryEvents(SESSION_A);
    expect(log.map((e) => e.type)).toEqual(["unshield", "shield"]);
  });

  it("keeps each session address's log separate", async () => {
    await recordSppBoundaryEvent(SESSION_A, { type: "shield", amount: "1", hashes: [] });
    await recordSppBoundaryEvent(SESSION_B, { type: "unshield", amount: "2", hashes: [] });
    expect(await listSppBoundaryEvents(SESSION_A)).toHaveLength(1);
    expect(await listSppBoundaryEvents(SESSION_B)).toHaveLength(1);
    expect((await listSppBoundaryEvents(SESSION_A))[0]!.type).toBe("shield");
  });

  it("caps the log length rather than growing unbounded", async () => {
    for (let i = 0; i < 205; i += 1) {
      await recordSppBoundaryEvent(SESSION_A, { type: "shield", amount: String(i), hashes: [] });
    }
    const log = await listSppBoundaryEvents(SESSION_A);
    expect(log.length).toBeLessThanOrEqual(200);
    // Newest survive the cap, not oldest.
    expect(log[0]!.amount).toBe("204");
  });
});
