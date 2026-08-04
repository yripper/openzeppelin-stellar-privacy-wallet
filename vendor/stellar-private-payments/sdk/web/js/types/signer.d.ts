/** Options passed as the last argument to wallet sign methods (injected by WASM). */
export interface SignOptions {
  address?: string;
  networkPassphrase?: string;
}

export type SignMessageResult =
  | string
  | {
      signedMessage: string;
      signerAddress?: string;
    };

export type SignTransactionResult =
  | string
  | {
      signedTxXdr: string;
      signerAddress?: string;
    };

export type SignAuthEntryResult =
  | string
  | {
      signedAuthEntry: string;
      signerAddress?: string;
    };

/**
 * Wallet adapter for {@link Client.account}.
 *
 * Must expose `signMessage`, `signTransaction`, and `signAuthEntry`.
 * Optional `getPublicKey` lets the JS wrapper resolve `userAddress`.
 */
export interface WalletSigner {
  signMessage(message: string, opts?: SignOptions): Promise<SignMessageResult>;
  signTransaction(xdr: string, opts?: SignOptions): Promise<SignTransactionResult>;
  signAuthEntry(xdr: string, opts?: SignOptions): Promise<SignAuthEntryResult>;
  getPublicKey?(): Promise<string>;
  /**
   * When present, takes over assembly, authorization, and submission of a
   * prepared transaction (e.g. a smart-account wallet signing auth entries
   * with a passkey and submitting through its own relayer). Receives the
   * unsigned transaction envelope XDR (base64) and resolves with the
   * submitted transaction's 64-char hex hash; the SDK's confirm loop then
   * polls that hash. `signTransaction`/`signAuthEntry` are not called for
   * transactions routed through this method.
   */
  executeTransaction?(xdr: string, opts?: SignOptions): Promise<string>;
}
