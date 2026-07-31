import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("parses a minimal valid env, defaulting POLL_INTERVAL_MS", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db" });
    expect(env).toEqual({
      DATABASE_URL: "postgres://user:pass@localhost:5433/db",
      POLL_INTERVAL_MS: 5000,
    });
  });

  it("coerces a supplied POLL_INTERVAL_MS from a string", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5433/db",
      POLL_INTERVAL_MS: "1500",
    });
    expect(env.POLL_INTERVAL_MS).toBe(1500);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow();
  });

  it("throws when DATABASE_URL is empty", () => {
    expect(() => loadEnv({ DATABASE_URL: "" })).toThrow();
  });

  it("throws when POLL_INTERVAL_MS is not a positive integer", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db", POLL_INTERVAL_MS: "0" }),
    ).toThrow();
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db", POLL_INTERVAL_MS: "abc" }),
    ).toThrow();
  });
});
