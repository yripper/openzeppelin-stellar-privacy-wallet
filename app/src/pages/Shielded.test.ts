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

import { describeResult, resolveNotices } from "./Shielded.js";

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
