/**
 * Owns the wallet connection lifecycle: silent session restore on mount,
 * passkey-backed wallet creation, returning-user connect, and the privacy
 * bundle that rides alongside the smart account (loaded from IndexedDB,
 * never sent to the backend).
 *
 * The bundle is paired to its wallet (`privacy-bundle.ts`'s
 * `walletContractId` + `resolveBundleForWallet`): this browser's single
 * IndexedDB bundle slot is never handed to a connecting session unless it
 * belongs to that session's `contractId` (or predates pairing entirely, in
 * which case it's stamped and adopted). `createWallet` also refuses to
 * silently overwrite an existing bundle that belongs to a different wallet.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { rpc } from "@stellar/stellar-sdk";
import { TESTNET } from "@grantfox/shared";

import { kit } from "../lib/kit.js";
import { createBundle, loadBundle, resolveBundleForWallet, saveBundle, type PrivacyBundle } from "../lib/privacy-bundle.js";
import { humanizeRelayerError } from "../lib/relayer-errors.js";

type WalletStatus = "restoring" | "creating" | "connecting" | "connected" | "disconnected";

interface WalletState {
  status: WalletStatus;
  contractId: string | undefined;
  credentialId: string | undefined;
  bundle: PrivacyBundle | undefined;
  /** True when this browser holds a privacy bundle, but it's paired to a DIFFERENT wallet than the one connected — see `privacy-bundle.ts`'s `resolveBundleForWallet`. `bundle` is `undefined` whenever this is true. */
  bundleMismatch: boolean;
  error: string | undefined;
}

interface WalletContextValue extends WalletState {
  /** Passkey-create a new smart account, fund it, and mint its privacy bundle. */
  createWallet: (userName: string) => Promise<{ contractId: string; bundle: PrivacyBundle }>;
  /** Passkey-authenticate an existing smart account (returning user). */
  connectExisting: () => Promise<{ contractId: string; bundleMissing: boolean; bundleMismatch: boolean }>;
  /** Re-read the bundle from IndexedDB (e.g. after a restore-from-backup). */
  refreshBundle: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

/** Deploy succeeded and confirmed on-chain -> the successful branch's `hash`; otherwise throws. */
function assertDeployed(submitResult: Awaited<ReturnType<typeof kit.createWallet>>["submitResult"]): void {
  if (submitResult && !submitResult.success) {
    const raw = submitResult.error.message;
    throw new Error(humanizeRelayerError(raw) ?? raw);
  }
  if (!submitResult) {
    throw new Error("Wallet deployment did not submit (no submitResult).");
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({
    status: "restoring",
    contractId: undefined,
    credentialId: undefined,
    bundle: undefined,
    bundleMismatch: false,
    error: undefined,
  });

  // Silent session restore on mount: no passkey prompt, returns null if
  // there's no stored session (first-time visitor or a signed-out browser).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await kit.connectWallet();
        if (cancelled) return;
        if (result) {
          const { bundle, mismatch } = await resolveBundleForWallet(result.contractId);
          setState({
            status: "connected",
            contractId: result.contractId,
            credentialId: result.credentialId,
            bundle,
            bundleMismatch: mismatch,
            error: undefined,
          });
        } else {
          setState((s) => ({ ...s, status: "disconnected" }));
        }
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: "disconnected",
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const createWallet = useCallback(async (userName: string) => {
    setState((s) => ({ ...s, status: "creating", bundleMismatch: false, error: undefined }));
    try {
      // This browser's privacy bundle lives in a single IndexedDB slot
      // (`privacy-bundle.ts`'s `saveBundle`, unconditional overwrite). A
      // brand-new wallet's contract id can never match whatever is already
      // stored here (it doesn't exist yet), so ANY existing bundle —
      // paired to a known different wallet, or a pre-pairing legacy one —
      // would be silently destroyed below. Ask first; checked before the
      // passkey prompt/deploy so a "no" costs the user nothing on-chain.
      const existing = await loadBundle();
      if (existing) {
        const owner = existing.walletContractId || "an earlier wallet created in this browser";
        const proceed = window.confirm(
          `This browser already holds privacy keys for ${owner}. Creating a new wallet will ` +
            "replace them here — connect with that wallet's passkey and export a backup first " +
            "if you haven't.\n\nContinue and create a new wallet anyway?"
        );
        if (!proceed) {
          throw new Error(
            "Wallet creation canceled: this browser's existing privacy keys were kept. " +
              "Connect with the existing wallet's passkey and export a backup, then try again."
          );
        }
      }

      const result = await kit.createWallet("GrantFox", userName, { autoSubmit: true });
      assertDeployed(result.submitResult);

      // Fee-sponsored deploy via the relayer means the wallet exists at
      // 0 XLM; friendbot-funding it now is what lets it pay for its own CT
      // deposit/transfer fees later. Non-fatal: the wallet is otherwise
      // fully created, so a friendbot hiccup shouldn't strand the user mid-flow.
      try {
        await new rpc.Server(TESTNET.rpcUrl).fundAddress(result.contractId);
      } catch (fundError) {
        console.warn("Friendbot funding failed (non-fatal, retry later):", fundError);
      }

      const bundle = createBundle(result.contractId);
      await saveBundle(bundle);

      setState({
        status: "connected",
        contractId: result.contractId,
        credentialId: result.credentialId,
        bundle,
        bundleMismatch: false,
        error: undefined,
      });
      return { contractId: result.contractId, bundle };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, status: "disconnected", error: message }));
      throw err;
    }
  }, []);

  const connectExisting = useCallback(async () => {
    setState((s) => ({ ...s, status: "connecting", bundleMismatch: false, error: undefined }));
    try {
      const result = await kit.connectWallet({ prompt: true });
      if (!result) {
        throw new Error("No passkey selected.");
      }
      const { bundle, mismatch } = await resolveBundleForWallet(result.contractId);
      setState({
        status: "connected",
        contractId: result.contractId,
        credentialId: result.credentialId,
        bundle,
        bundleMismatch: mismatch,
        error: undefined,
      });
      return { contractId: result.contractId, bundleMissing: !bundle, bundleMismatch: mismatch };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, status: "disconnected", error: message }));
      throw err;
    }
  }, []);

  const refreshBundle = useCallback(async () => {
    const bundle = await loadBundle();
    setState((s) => ({ ...s, bundle }));
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({ ...state, createWallet, connectExisting, refreshBundle }),
    [state, createWallet, connectExisting, refreshBundle]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return ctx;
}
