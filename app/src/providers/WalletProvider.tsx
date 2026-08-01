/**
 * Owns the wallet connection lifecycle: silent session restore on mount,
 * passkey-backed wallet creation, returning-user connect, and the privacy
 * bundle that rides alongside the smart account (loaded from IndexedDB,
 * never sent to the backend).
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
import { createBundle, loadBundle, saveBundle, type PrivacyBundle } from "../lib/privacy-bundle.js";

type WalletStatus = "restoring" | "creating" | "connecting" | "connected" | "disconnected";

interface WalletState {
  status: WalletStatus;
  contractId: string | undefined;
  credentialId: string | undefined;
  bundle: PrivacyBundle | undefined;
  error: string | undefined;
}

interface WalletContextValue extends WalletState {
  /** Passkey-create a new smart account, fund it, and mint its privacy bundle. */
  createWallet: (userName: string) => Promise<{ contractId: string; bundle: PrivacyBundle }>;
  /** Passkey-authenticate an existing smart account (returning user). */
  connectExisting: () => Promise<{ contractId: string; bundleMissing: boolean }>;
  /** Re-read the bundle from IndexedDB (e.g. after a restore-from-backup). */
  refreshBundle: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

/** Deploy succeeded and confirmed on-chain -> the successful branch's `hash`; otherwise throws. */
function assertDeployed(submitResult: Awaited<ReturnType<typeof kit.createWallet>>["submitResult"]): void {
  if (submitResult && !submitResult.success) {
    throw new Error(submitResult.error.message);
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
          const bundle = await loadBundle();
          setState({
            status: "connected",
            contractId: result.contractId,
            credentialId: result.credentialId,
            bundle,
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
    setState((s) => ({ ...s, status: "creating", error: undefined }));
    try {
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
    setState((s) => ({ ...s, status: "connecting", error: undefined }));
    try {
      const result = await kit.connectWallet({ prompt: true });
      if (!result) {
        throw new Error("No passkey selected.");
      }
      const bundle = await loadBundle();
      setState({
        status: "connected",
        contractId: result.contractId,
        credentialId: result.credentialId,
        bundle,
        error: undefined,
      });
      return { contractId: result.contractId, bundleMissing: !bundle };
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
