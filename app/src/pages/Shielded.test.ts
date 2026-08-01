/**
 * `Shielded.tsx`'s pure decision functions.
 *
 * No component-render harness in this repo (same convention as
 * `ActivityFeed.test.ts`): the logic worth pinning is extracted as plain
 * functions and tested directly.
 *
 * `resolveNotices` is the fix for a review finding with real money-loss
 * implications — a post-action refresh failure used to overwrite the action's
 * own outcome, so a user could see "Reading shielded state failed" instead of
 * "Shielding 10 XLM confirmed" for a transaction that had already settled.
 */
import { describe, expect, it } from "vitest";

import { SppWalletSwitchError, type SppRail } from "../lib/spp.js";
import {
  connectReducer,
  describeResult,
  initialConnectState,
  resolveNotices,
  type ConnectEvent,
  type ConnectState,
} from "./Shielded.js";

describe("resolveNotices", () => {
  const outcome = { kind: "ok", text: "Shielding 10 XLM confirmed in 1 transaction(s) — abc…" } as const;

  it("keeps the action's outcome when the refresh also succeeded", () => {
    expect(resolveNotices(outcome, undefined)).toEqual({
      notice: outcome,
      staleWarning: undefined,
    });
  });

  it("KEEPS the action's outcome when the refresh failed, and warns separately", () => {
    // The regression this guards: a transient `client.sync()` failure must not
    // replace the confirmation of a transaction that moved money.
    expect(resolveNotices(outcome, "rpc timeout")).toEqual({
      notice: outcome,
      staleWarning: "rpc timeout",
    });
  });

  it("preserves aspNotReady copy through a failed refresh", () => {
    const asp = { kind: "warn", text: "…isn't approved by the pool's association-set provider…" } as const;
    expect(resolveNotices(asp, "rpc timeout").notice).toBe(asp);
  });

  it("preserves a failure notice through a failed refresh", () => {
    const failed = { kind: "error", text: "Shielded send failed: insufficient notes" } as const;
    expect(resolveNotices(failed, "rpc timeout").notice).toBe(failed);
  });

  it("reports the refresh failure only when the action produced nothing to say", () => {
    expect(resolveNotices(undefined, "rpc timeout")).toEqual({
      notice: { kind: "error", text: "Reading shielded state failed: rpc timeout" },
      staleWarning: undefined,
    });
  });

  it("reports nothing when neither the action nor the refresh has news", () => {
    expect(resolveNotices(undefined, undefined)).toEqual({
      notice: undefined,
      staleWarning: undefined,
    });
  });
});

describe("describeResult", () => {
  it("reports success with the transaction count and last hash", () => {
    const notice = describeResult({ status: "ok", hashes: ["a".repeat(64)] }, "Shielding 10 XLM");
    expect(notice.kind).toBe("ok");
    expect(notice.text).toContain("Shielding 10 XLM confirmed in 1 transaction(s)");
  });

  it("explains aspNotReady as a WARNING, not a failure, and names the ASP", () => {
    const notice = describeResult({ status: "aspNotReady" }, "Shielded send");
    expect(notice.kind).toBe("warn");
    expect(notice.text).toContain("association-set provider");
    expect(notice.text).not.toContain("failed");
  });

  it("surfaces a failure's message AND any transactions that already went through", () => {
    const notice = describeResult(
      { status: "failed", hashes: ["b".repeat(64)], message: "plan step 2 reverted" },
      "Shielded send"
    );
    expect(notice.kind).toBe("error");
    expect(notice.text).toContain("plan step 2 reverted");
    // Partial execution is the dangerous case: the user must be told money moved.
    expect(notice.text).toContain("1 transaction(s) already submitted");
  });

  it("does not invent a partial-submission clause when nothing was submitted", () => {
    const notice = describeResult(
      { status: "failed", hashes: [], message: "simulation failed" },
      "Shielding"
    );
    expect(notice.text).not.toContain("already submitted");
  });
});

describe("connectReducer", () => {
  const RAIL_A = { sessionAddress: "GA…" } as unknown as SppRail;
  const RAIL_B = { sessionAddress: "GB…" } as unknown as SppRail;

  /** Replay a whole effect sequence, exactly as the component dispatches it. */
  function run(events: ConnectEvent[], from: ConnectState = initialConnectState): ConnectState {
    return events.reduce(connectReducer, from);
  }

  it("tracks phases through a successful connect", () => {
    const state = run([
      { type: "attempt" },
      { type: "phase", phase: "syncing-history" },
      { type: "phase", phase: "deriving-keys" },
      { type: "connected", rail: RAIL_A },
    ]);
    expect(state).toEqual({
      rail: RAIL_A,
      phase: "deriving-keys",
      error: undefined,
      needsReload: false,
    });
  });

  it("records a wallet-switch rejection as the reload gate", () => {
    const state = run([{ type: "attempt" }, { type: "failed", error: new SppWalletSwitchError() }]);
    expect(state.needsReload).toBe(true);
    expect(state.error).toContain("page reload");
  });

  it("records an ordinary failure WITHOUT arming the reload gate", () => {
    const state = run([{ type: "attempt" }, { type: "failed", error: new Error("api server down") }]);
    expect(state).toMatchObject({ needsReload: false, error: "api server down" });
  });

  it("stringifies a non-Error rejection rather than rendering [object Object]", () => {
    expect(run([{ type: "failed", error: "boom" }]).error).toBe("boom");
  });

  it("clears a stale reload gate when the next attempt begins", () => {
    // THE REGRESSION: wallet A → switch to B (rejected) → reconnect A. Before
    // this reducer, `needsReload` was never cleared, so the render gate blocked
    // a tab whose rail had connected perfectly well.
    const state = run([
      { type: "attempt" },
      { type: "connected", rail: RAIL_A },
      { type: "attempt" },
      { type: "failed", error: new SppWalletSwitchError() },
      { type: "attempt" }, // user reconnects wallet A; the memo hits and resolves
      { type: "connected", rail: RAIL_A },
    ]);
    expect(state).toEqual({
      rail: RAIL_A,
      phase: "loading-sdk",
      error: undefined,
      needsReload: false,
    });
  });

  it("clears failure state on `connected` even if no `attempt` preceded it", () => {
    const failed = run([{ type: "attempt" }, { type: "failed", error: new SppWalletSwitchError() }]);
    const recovered = connectReducer(failed, { type: "connected", rail: RAIL_B });
    expect(recovered).toMatchObject({ rail: RAIL_B, error: undefined, needsReload: false });
  });

  it("keeps the existing rail across a re-attempt, so the tab does not flash back to loading", () => {
    const connected = run([{ type: "attempt" }, { type: "connected", rail: RAIL_A }]);
    expect(connectReducer(connected, { type: "attempt" }).rail).toBe(RAIL_A);
  });

  it("leaves the rail in place when a later attempt fails, so state is never half-torn", () => {
    const state = run([
      { type: "attempt" },
      { type: "connected", rail: RAIL_A },
      { type: "attempt" },
      { type: "failed", error: new Error("rpc down") },
    ]);
    expect(state.rail).toBe(RAIL_A);
    expect(state.error).toBe("rpc down");
  });
});
