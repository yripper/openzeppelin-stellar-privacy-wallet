/**
 * `humanizeError` — the CT rail's shared humanizer over `@ctd/sdk`'s
 * `humanizeContractError` (real contract error codes, `packages/ctd-sdk/src/chain/errors.ts`)
 * layered with `relayer-errors.ts`'s relayer table.
 */
import { describe, expect, it } from "vitest";

import { humanizeError } from "./errors.js";

describe("humanizeError", () => {
  it("humanizes a known confidential-token contract error code (3501: not registered)", () => {
    const message = humanizeError(new Error("HostError: Error(Contract, #3501)\nEvent log (newest first):"));
    expect(message).toContain("not registered");
    expect(message).not.toContain("HostError");
  });

  it("humanizes a known compliance error code (3601: frozen account)", () => {
    const message = humanizeError(new Error("Error(Contract, #3601)"));
    expect(message).toContain("frozen");
  });

  it("falls back to a generic '#N' message for an unmapped-but-parseable contract code", () => {
    // 3515 is not in `CONTRACT_ERRORS` (the table stops at 3514) — proves the
    // generic fallback fires instead of silently returning nothing useful.
    expect(humanizeError(new Error("Error(Contract, #3515)"))).toContain("#3515");
  });

  it("falls back to the relayer table when no contract code is present", () => {
    expect(humanizeError(new Error("POOL_CAPACITY"))).toContain("channel accounts are in use");
  });

  it("prefers the contract-error table over the relayer table when both could theoretically match", () => {
    // A contract-code match always wins: relayer codes are plain uppercase
    // words that never contain "Error(Contract, #N)".
    const message = humanizeError(new Error("Error(Contract, #3500)"));
    expect(message).toContain("already registered");
  });

  it("passes an unrecognized message through unchanged", () => {
    expect(humanizeError(new Error("network request failed"))).toBe("network request failed");
  });

  it("accepts a plain string, not just an Error instance", () => {
    expect(humanizeError("Error(Contract, #3601)")).toContain("frozen");
  });

  it("falls back to a generic message for an empty error", () => {
    expect(humanizeError(new Error(""))).toBe("Something went wrong. Please try again.");
  });

  it("stringifies a non-Error, non-string rejection rather than throwing", () => {
    expect(humanizeError({ weird: true })).toBe("[object Object]");
  });
});
