/**
 * SmartAccountKit singleton: the OpenZeppelin passkey smart-account client.
 *
 * Config fields are exactly the ones documented at
 * resources/smart-account-kit/src/types.ts:107-273 (`SmartAccountConfig`) —
 * no invented fields. `relayerUrl` (TESTNET.smartAccount.relayerUrl) routes
 * deploy/submit through SDF's Channels relayer proxy for fee-sponsored
 * (0-XLM-fee-source) submission; see kit.createWallet's `autoSubmit` call in
 * providers/WalletProvider.tsx.
 */
import { SmartAccountKit, IndexedDBStorage } from "smart-account-kit";
import { TESTNET } from "@privacy-wallet/shared";

export const kit = new SmartAccountKit({
  rpcUrl: TESTNET.rpcUrl,
  networkPassphrase: TESTNET.networkPassphrase,
  accountWasmHash: TESTNET.smartAccount.accountWasmHash,
  webauthnVerifierAddress: TESTNET.smartAccount.webauthnVerifierAddress,
  ed25519VerifierAddress: TESTNET.smartAccount.ed25519VerifierAddress,
  relayerUrl: TESTNET.smartAccount.relayerUrl,
  rpName: "Privacy Wallet",
  storage: new IndexedDBStorage(),
});
