/**
 * The unified Activity view: Confidential Token activity (register/deposit/
 * merge/withdraw/transfer, from `@privacy-wallet/api`) alongside this wallet's SPP
 * shield/unshield boundary events (recorded locally — see
 * `lib/spp-boundary-log.ts`'s module doc for why).
 *
 * Presented as two separate, clearly-labeled sections rather than one
 * chronologically-interleaved list: CT rows are ordered by ledger (an
 * on-chain sequence number) and SPP boundary rows by this browser's local
 * clock at the moment they were recorded — two different clocks with no
 * reliable common conversion available client-side (a ledger's close time
 * isn't looked up per-row here), so merging them into one sorted timeline
 * would imply a precision this view doesn't actually have. Each section is
 * independently newest-first, which is honest and still answers "what has
 * this wallet been doing" at a glance.
 *
 * Reuses the existing per-rail components unchanged (`ActivityFeed` — the CT
 * tab's own activity list; `SppBoundaryFeed` — new, SPP-only) rather than
 * re-implementing CT's fetch/decrypt logic here — this view is additive, the
 * per-rail tabs (`Confidential`/`Shielded`) keep their own activity/history
 * surfaces exactly as before.
 */
import { CtProvider } from "../providers/CtProvider.js";
import { useWallet } from "../providers/WalletProvider.js";
import ActivityFeed from "../components/ActivityFeed.js";
import SppBoundaryFeed from "../components/SppBoundaryFeed.js";
import { sessionKeypair } from "../lib/spp-signer.js";

export default function Activity() {
  const { contractId, bundle } = useWallet();

  if (!contractId || !bundle) {
    return (
      <section className="balance-card">
        <p className="muted">Connect a wallet to see activity.</p>
      </section>
    );
  }

  // Pure derivation from the already-loaded privacy bundle — no SPP SDK
  // connection needed just to know which session address's boundary log to
  // read (see `SppBoundaryFeed`'s module doc).
  const sessionAddress = sessionKeypair(bundle.sppRootSecret).publicKey();

  return (
    <div className="confidential stack">
      <CtProvider>
        <ActivityFeed />
      </CtProvider>
      <SppBoundaryFeed sessionAddress={sessionAddress} />
    </div>
  );
}
