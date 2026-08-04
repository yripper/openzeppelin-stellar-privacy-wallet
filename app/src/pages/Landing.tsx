/**
 * Entry point: silently tries to restore a session (WalletProvider does this
 * on mount); once we know the answer, routes to the wallet home (or, on a
 * wallet/bundle pairing mismatch, restore-from-backup), or renders the
 * landing page.
 *
 * The landing sells the product with the interface's own device: printed on
 * the paper = public on the ledger, inside a black block = redacted. The hero
 * ledger is a mock (no chain reads on a page that must load instantly for
 * someone with no wallet), but every claim it illustrates is one the app
 * makes for real — CT publishes parties and hides amounts; a shielded send
 * inside the pool leaves no readable row at all.
 */
import { Navigate, useNavigate } from "react-router";

import { useWallet } from "../providers/WalletProvider.js";

const REPO_URL = "https://github.com/yripper/openzeppelin-stellar-privacy-wallet";

function CreateWalletButton({ className, label = "Create a new wallet" }: { className?: string; label?: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" className={className} onClick={() => navigate("/onboarding")}>
      {label}
    </button>
  );
}

export default function Landing() {
  const { status, bundleMismatch } = useWallet();
  const navigate = useNavigate();

  if (status === "restoring") {
    return (
      <main className="screen">
        <p>Checking for an existing session…</p>
      </main>
    );
  }

  if (status === "connected") {
    // A silently-restored session can hit the same wallet/bundle pairing
    // mismatch `connectExisting` guards against (see `WalletProvider`'s
    // module doc) — route to restore-from-backup instead of the wallet
    // home, same as `Connect.tsx` does for a fresh connect.
    return (
      <Navigate
        to={bundleMismatch ? "/restore" : "/wallet"}
        replace
        state={bundleMismatch ? { mismatch: true } : undefined}
      />
    );
  }

  return (
    <>
      <header className="shell-header landing-nav">
        <strong>
          <span className="mark" aria-hidden="true">
            <i />
            <i />
          </span>
          Privacy Wallet
        </strong>
        <CreateWalletButton className="btn-small" />
      </header>

      <main className="screen landing">
        {/* ------------------------------------------------------------ hero */}
        <section className="landing-hero">
          <p className="landing-eyebrow">Stellar testnet · passkey smart account · two privacy rails</p>
          <h1>
            The ledger is public.
            <br />
            Your business isn&rsquo;t.
          </h1>
          <p className="landing-sub">
            A Stellar wallet secured by your fingerprint instead of a seed phrase, with
            confidential balances for everyday transfers and a shielded pool for private
            ones — a pool whose idle liquidity earns yield in{" "}
            <a href="https://defindex.io" target="_blank" rel="noreferrer">
              DeFindex
            </a>{" "}
            while it waits.
          </p>
          <div className="landing-cta-row">
            <CreateWalletButton />
            <button type="button" className="btn-ghost" onClick={() => navigate("/connect")}>
              I already have a wallet
            </button>
          </div>

          {/* What the ledger sees — the product's claim, printed as a ledger. */}
          <figure className="landing-ledger" aria-label="What the public ledger records for each kind of transfer">
            <figcaption className="cell-label">What the public ledger sees</figcaption>
            <ul>
              <li className="landing-ledger-row">
                <span className="landing-ledger-type">Public payment</span>
                <span className="landing-ledger-amount">
                  250.<span className="frac">0000000</span>
                  <span className="unit">XLM</span>
                </span>
                <span className="chip chip-exposed">printed on the ledger</span>
              </li>
              <li className="landing-ledger-row">
                <span className="landing-ledger-type">Confidential transfer</span>
                <span className="landing-ledger-amount landing-redacted-bar" aria-label="amount encrypted">
                  &nbsp;
                </span>
                <span className="chip chip-veil">amount encrypted</span>
              </li>
              <li className="landing-ledger-row">
                <span className="landing-ledger-type">Shielded send</span>
                <span className="landing-ledger-amount landing-redacted-bar wide" aria-label="nothing to read">
                  &nbsp;
                </span>
                <span className="chip chip-veil">off the record</span>
              </li>
            </ul>
          </figure>
        </section>

        {/* ----------------------------------------------------- how it works */}
        <section className="landing-section">
          <p className="landing-eyebrow">How it works</p>
          <h2 className="landing-h2">Three pieces, one wallet</h2>
          <div className="cells landing-cells">
            <div className="cell">
              <p className="cell-label">Passkey smart account</p>
              <p className="landing-cell-body">
                Onboard with Face&nbsp;ID or a fingerprint. A WebAuthn-secured Soroban smart
                account (<code>C…</code> address) holds your funds; transaction fees are
                sponsored through a relayer. Nothing to write down for day-to-day use — an
                encrypted backup file covers recovery.
              </p>
            </div>
            <div className="cell">
              <p className="cell-label">Confidential transfers</p>
              <p className="landing-cell-body">
                Deposit into a confidential balance, then send with the amount encrypted on
                chain. The zero-knowledge proof is generated in your browser — no server
                ever sees your numbers. Only you (and a compliance auditor) can decrypt
                them.
              </p>
            </div>
            <div className="cell">
              <p className="cell-label">Shielded pool</p>
              <p className="landing-cell-body">
                Shield XLM into a pool shared with other participants and send privately
                inside it. Only the shield and unshield boundary events are public —
                inside the pool, who paid whom, and how much, is nobody&rsquo;s business.
              </p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ yield */}
        <section className="landing-section">
          <p className="landing-eyebrow">The pool earns its keep</p>
          <h2 className="landing-h2">Idle liquidity works in DeFindex</h2>
          <p>
            Deposits waiting inside a privacy pool normally earn nothing. We forked the pool
            contract so they don&rsquo;t just sit there:
          </p>
          <ol className="landing-steps">
            <li>
              <span className="landing-step-n">1</span>
              <div>
                <b>Deposits accumulate.</b> Shielded XLM lands in the pool&rsquo;s balance,
                like any other privacy pool.
              </div>
            </li>
            <li>
              <span className="landing-step-n">2</span>
              <div>
                <b>Idle funds batch-invest.</b> Once idle liquidity crosses 1,000&nbsp;XLM,
                the pool deposits it into a DeFindex vault in one call — keeping a
                200&nbsp;XLM buffer liquid for withdrawals.
              </div>
            </li>
            <li>
              <span className="landing-step-n">3</span>
              <div>
                <b>Withdrawals always come first.</b> An unshield that exceeds idle funds
                divests from the vault in the same transaction. Depositors never wait on
                the vault.
              </div>
            </li>
            <li>
              <span className="landing-step-n">4</span>
              <div>
                <b>The yield is the service fee.</b> Whatever the vault earns above what the
                pool owes depositors is collected by the operator to fund the service.
              </div>
            </li>
          </ol>
          <p className="legend legend-exposed">
            <span className="dot dot-exposed" aria-hidden="true" />
            <span>
              <b>Your principal is untouchable by arithmetic, not by promise.</b> The
              contract tracks exactly what it owes depositors; the collect function can
              only pay out the surplus above that number. Pool-level figures — owed,
              idle, invested, accrued — are public, and the app shows them live.
            </span>
          </p>
        </section>

        {/* ------------------------------------------------------- built with */}
        <section className="landing-section">
          <p className="landing-eyebrow">Built for the Stellar Privacy hackathon</p>
          <h2 className="landing-h2">Where the stack stopped short, we forked</h2>
          <ul className="landing-forks">
            <li>
              <b>SDK fork.</b> The stock shielded-pool SDK only spoke classic ed25519
              accounts. Ours lets the smart account itself shield, receive, and unshield —
              passkey-authorized, no throwaway side account.
            </li>
            <li>
              <b>Contract fork.</b> The yield-bearing pool above, with the
              depositor-protection invariant built into its arithmetic.
            </li>
            <li>
              <b>Our own indexer.</b> The pool&rsquo;s history predates public RPC
              retention and the reference bootnode is down — so we recovered the history
              and serve the only working bootnode for this pool, open to other builders.
            </li>
          </ul>
          <p>
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Read the source on GitHub
            </a>{" "}
            — contracts, forks, indexer, and this app.
          </p>
        </section>

        {/* --------------------------------------------------------- CTA band */}
        <section className="landing-final">
          <h2 className="landing-h2">Open a wallet in about a minute</h2>
          <p className="landing-sub">
            Testnet, free play money from friendbot, and your fingerprint is the key.
          </p>
          <div className="landing-cta-row">
            <CreateWalletButton />
            <button type="button" className="btn-ghost" onClick={() => navigate("/connect")}>
              I already have a wallet
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
