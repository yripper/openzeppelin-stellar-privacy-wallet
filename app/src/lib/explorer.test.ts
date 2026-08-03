import { describe, expect, it } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { TESTNET } from "@privacy-wallet/shared";

import { addressUrl, explorerNetwork, txUrl } from "./explorer.js";

const HASH = "83f685f5b597fa1bb2f6648a2017d7e81625097fb0f3a81d9654992850079a85";

describe("explorerNetwork", () => {
  it("maps the two networks stellar.expert hosts", () => {
    expect(explorerNetwork(Networks.PUBLIC)).toBe("public");
    expect(explorerNetwork(Networks.TESTNET)).toBe("testnet");
  });

  it("returns undefined for a network with no public explorer", () => {
    expect(explorerNetwork("Standalone Network ; February 2017")).toBeUndefined();
  });
});

describe("txUrl", () => {
  it("builds a testnet transaction URL from this app's configured network", () => {
    expect(txUrl(HASH)).toBe(`https://stellar.expert/explorer/testnet/tx/${HASH}`);
  });

  it("uses the full hash, not a truncated one", () => {
    expect(txUrl(HASH)).toContain(HASH);
  });

  it("follows the configured passphrase rather than assuming testnet", () => {
    expect(txUrl(HASH, Networks.PUBLIC)).toBe(`https://stellar.expert/explorer/public/tx/${HASH}`);
  });

  it("returns undefined rather than a 404 link for an unhosted network", () => {
    expect(txUrl(HASH, "Standalone Network ; February 2017")).toBeUndefined();
  });

  it("returns undefined for an empty hash", () => {
    expect(txUrl("")).toBeUndefined();
  });
});

describe("addressUrl", () => {
  it("builds an account URL for a contract address", () => {
    const c = "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH";
    expect(addressUrl(c)).toBe(`https://stellar.expert/explorer/testnet/account/${c}`);
  });

  it("returns undefined for an empty address", () => {
    expect(addressUrl("")).toBeUndefined();
  });
});

describe("app network configuration", () => {
  it("is testnet, which is what the default explorer links assume", () => {
    expect(TESTNET.networkPassphrase).toBe(Networks.TESTNET);
  });
});
