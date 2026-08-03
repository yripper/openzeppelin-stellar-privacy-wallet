/**
 * Route guard for `/wallet`.
 *
 * `Shell` assumes a session that can actually decrypt: without one, every CT
 * component sits on "Loading confidential wallet…" forever, because
 * `CtProvider` silently leaves `rail` undefined when `contractId`/`bundle` is
 * missing (`CtProvider.tsx:47-51`) and nothing ever errors. Deep-linking to
 * `/wallet` therefore looked like a hung app rather than a signed-out one.
 *
 * Three separate ways to reach that dead end, all handled here because
 * `/wallet` is reachable directly by URL and so cannot rely on the checks the
 * pages that normally link to it already do:
 *
 *  1. No session at all -> `/`. (`Landing` sends signed-out users to the
 *     create/connect choice.)
 *  2. Session, but this browser holds no privacy bundle -> `/restore`. Same
 *     destination `Connect.tsx` picks for its `bundleMissing` case; the
 *     silent-restore path in `Landing` never checked for it, so a browser
 *     with a live passkey session and cleared IndexedDB landed here.
 *  3. Session, but the stored bundle belongs to a DIFFERENT wallet
 *     (`bundleMismatch`) -> `/restore`, carrying the same `{mismatch: true}`
 *     state `Landing`/`Connect` pass so the page explains itself.
 *
 * `restoring` is a real state, not a bounce: `WalletProvider` attempts a
 * silent session restore on mount (`WalletProvider.tsx:76-103`, which always
 * terminates in `connected` or `disconnected`, including on throw), so
 * redirecting before it resolves would kick out every returning user.
 */
import { Navigate } from "react-router";
import type { ReactNode } from "react";

import { useWallet } from "../providers/WalletProvider.js";

export default function RequireWallet({ children }: { children: ReactNode }) {
  const { status, bundle, bundleMismatch } = useWallet();

  if (status === "disconnected") return <Navigate to="/" replace />;

  if (status === "connected") {
    if (bundleMismatch) return <Navigate to="/restore" replace state={{ mismatch: true }} />;
    if (!bundle) return <Navigate to="/restore" replace />;
    return <>{children}</>;
  }

  // restoring / creating / connecting — an answer is still coming.
  return (
    <main className="screen">
      <p className="muted">Checking for an existing session…</p>
    </main>
  );
}
