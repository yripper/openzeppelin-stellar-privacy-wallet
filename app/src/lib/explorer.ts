/**
 * Block-explorer links.
 *
 * Every transaction hash the wallet shows is something the user can go and
 * verify for themselves — which matters more here than in an ordinary wallet,
 * because the product's whole claim is about what the public ledger does and
 * doesn't record. A user who can open a confidential transfer on stellar.expert
 * and see that no amount appears has checked the claim rather than believed it.
 *
 * The network segment is derived from `TESTNET.networkPassphrase` rather than
 * hard-coded, so pointing the app at pubnet can't silently keep linking
 * testnet URLs.
 */
import { Networks } from "@stellar/stellar-sdk";
import { TESTNET } from "@privacy-wallet/shared";

const EXPLORER_ORIGIN = "https://stellar.expert";

/** stellar.expert's path segment for a network passphrase, or `undefined` for a network it doesn't host (e.g. a local standalone). */
export function explorerNetwork(passphrase: string): "public" | "testnet" | undefined {
  if (passphrase === Networks.PUBLIC) return "public";
  if (passphrase === Networks.TESTNET) return "testnet";
  return undefined;
}

/**
 * stellar.expert URL for a transaction, or `undefined` when the hash is empty
 * or the configured network has no public explorer — callers render plain text
 * in that case rather than a link that would 404.
 */
export function txUrl(hash: string, passphrase: string = TESTNET.networkPassphrase): string | undefined {
  const network = explorerNetwork(passphrase);
  if (!network || !hash) return undefined;
  return `${EXPLORER_ORIGIN}/explorer/${network}/tx/${hash}`;
}

/** stellar.expert URL for an account or contract address (both live under `/account/` there). */
export function addressUrl(
  address: string,
  passphrase: string = TESTNET.networkPassphrase
): string | undefined {
  const network = explorerNetwork(passphrase);
  if (!network || !address) return undefined;
  return `${EXPLORER_ORIGIN}/explorer/${network}/account/${address}`;
}
