/**
 * `humanizeRelayerError` — pinned against `smart-account-kit`'s real
 * `RelayerErrorCodes` values (`smart-account-kit`'s own `relayer.ts`), not
 * hand-typed strings, so a future kit bump that renames a code fails this
 * suite instead of silently going unmapped.
 */
import { RelayerErrorCodes } from "smart-account-kit";
import { describe, expect, it } from "vitest";

import { humanizeRelayerError } from "./relayer-errors.js";

describe("humanizeRelayerError", () => {
  it("maps every RelayerErrorCodes value to non-empty, human copy", () => {
    for (const code of Object.values(RelayerErrorCodes)) {
      const message = humanizeRelayerError(code);
      expect(message).not.toBeNull();
      expect(message!.length).toBeGreaterThan(0);
      // The copy must not just echo the SCREAMING_SNAKE_CASE code back.
      expect(message).not.toBe(code);
    }
  });

  it("matches the FEE_LIMIT_EXCEEDED code when it IS the entire message text (the common shape — see module doc)", () => {
    expect(humanizeRelayerError(RelayerErrorCodes.FEE_LIMIT_EXCEEDED)).toContain("fee-sponsoring quota");
  });

  it("matches a code embedded in extra proxy text as a substring", () => {
    expect(humanizeRelayerError(`Relayer error: ${RelayerErrorCodes.POOL_CAPACITY}`)).toContain(
      "channel accounts are in use"
    );
  });

  it("matches the relayer client's own literal timeout message", () => {
    expect(humanizeRelayerError("Relayer request timed out")).toContain("took too long");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(humanizeRelayerError(`  ${RelayerErrorCodes.UNAUTHORIZED}  `)).toContain("rejected this request");
  });

  it("returns null for a message that names no known relayer failure", () => {
    expect(humanizeRelayerError("Wallet deployment did not submit (no submitResult).")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(humanizeRelayerError("")).toBeNull();
  });
});
