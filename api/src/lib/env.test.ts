import { TESTNET } from "@privacy-wallet/shared";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("parses a minimal valid env, defaulting POLL_INTERVAL_MS/RPC_URL/BOOTNODE_URL/PORT", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db" });
    expect(env).toEqual({
      DATABASE_URL: "postgres://user:pass@localhost:5433/db",
      POLL_INTERVAL_MS: 5000,
      RPC_URL: TESTNET.rpcUrl,
      BOOTNODE_URL: TESTNET.spp.nethermindBootnode,
      PORT: 3000,
    });
  });

  it("coerces a supplied PORT from a string", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db", PORT: "8080" });
    expect(env.PORT).toBe(8080);
  });

  it("throws when PORT is not a positive integer", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db", PORT: "0" }),
    ).toThrow();
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db", PORT: "not-a-port" }),
    ).toThrow();
  });

  it("uses supplied RPC_URL/BOOTNODE_URL overrides instead of the TESTNET defaults", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5433/db",
      RPC_URL: "https://rpc.example",
      BOOTNODE_URL: "https://bootnode.example",
    });
    expect(env.RPC_URL).toBe("https://rpc.example");
    expect(env.BOOTNODE_URL).toBe("https://bootnode.example");
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

  it("throws on an empty RPC_URL/BOOTNODE_URL rather than silently falling back to the default (zod's .default() only applies to a MISSING key, not an empty string) — .env.example must leave these commented out, not set to `KEY=`", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db", RPC_URL: "" }),
    ).toThrow();
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5433/db", BOOTNODE_URL: "" }),
    ).toThrow();
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
