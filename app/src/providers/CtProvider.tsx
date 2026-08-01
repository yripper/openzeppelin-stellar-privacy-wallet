/**
 * React context wrapping one `CtRail` instance per connected wallet session —
 * mirrors the `kit.ts` (plain client) / `WalletProvider.tsx` (React context)
 * split for the Confidential Token rail's `ct.ts` (plain orchestrator).
 *
 * A `CtRail` is expensive to keep re-creating (its bb.js provers lazily load
 * WASM + the Barretenberg CRS) and its `StateEngine` caches openings in
 * `localStorage` keyed by address — one shared instance per session, reused
 * across `BalanceCard`/`SendForm`/`ActivityFeed`, is both a performance and a
 * correctness concern (a fresh instance per component would still work, just
 * redundantly).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { useWallet } from "./WalletProvider.js";
import { CtRail, type CtView } from "../lib/ct.js";

interface CtContextValue {
  /** `undefined` until the wallet's C-address + privacy bundle are both available. */
  rail: CtRail | undefined;
  view: CtView | undefined;
  loading: boolean;
  error: string | undefined;
  /** Re-sync from chain events and re-read the balance snapshot. */
  refresh: () => Promise<void>;
}

const CtContext = createContext<CtContextValue | undefined>(undefined);

export function CtProvider({ children }: { children: ReactNode }) {
  const { contractId, bundle } = useWallet();
  const [rail, setRail] = useState<CtRail | undefined>(undefined);
  const [view, setView] = useState<CtView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // One CtRail per (contractId, bundle) pair; torn down (freeing bb.js
  // provers) whenever the session changes or this provider unmounts.
  useEffect(() => {
    if (!contractId || !bundle) {
      setRail(undefined);
      setView(undefined);
      return;
    }
    const instance = CtRail.connect(contractId, bundle.ctKeys);
    setRail(instance);
    return () => {
      void instance.destroy();
    };
  }, [contractId, bundle]);

  const refresh = useCallback(async () => {
    if (!rail) return;
    setLoading(true);
    setError(undefined);
    try {
      setView(await rail.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <CtContext.Provider value={{ rail, view, loading, error, refresh }}>
      {children}
    </CtContext.Provider>
  );
}

export function useCt(): CtContextValue {
  const ctx = useContext(CtContext);
  if (!ctx) {
    throw new Error("useCt must be used within a CtProvider");
  }
  return ctx;
}
