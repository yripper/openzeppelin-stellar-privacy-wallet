# Demo video script

Target length: 3-4 minutes. Matches the spec's demo story
(`docs/superpowers/specs/2026-07-31-privacy-wallet-design.md`, §11): *Alice
onboards with a passkey → funds → CT: activate privacy, deposit, private send
to Bob (explorer shows no amount, wallet shows decrypted) → SPP: shield,
private transfer to Carol, unshield (explorer shows nothing linking) →
activity history served from our indexer past RPC retention → compliance
close: auditor channel + ASP + public bootnode URL.*

## Before recording — have these open

- **Tabs**: the wallet app (three separate browser profiles/windows, one per
  persona below, so each keeps its own passkey — Chrome profiles or three
  separate browser contexts work), plus
  [stellar.expert testnet explorer](https://stellar.expert/explorer/testnet).
- **Wallet app**: https://app-production-2f5e.up.railway.app
- **CT token contract on the explorer** (for the "explorer shows no amount"
  beat): https://stellar.expert/explorer/testnet/contract/CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH
- **SPP pool contract on the explorer** (for the "explorer shows nothing
  linking" beat): https://stellar.expert/explorer/testnet/contract/CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI
- **API health / bootnode**, to have ready for the compliance close:
  https://api-production-70a0.up.railway.app/health and
  https://api-production-70a0.up.railway.app/rpc
- Three personas, each their own browser profile so passkeys don't collide:
  **Alice** (sender), **Bob** (CT recipient), **Carol** (SPP recipient).
- A terminal window ready to `curl` the auditor decrypt + bootnode calls for
  the compliance close (commands below — copy them in advance so you're not
  typing live).

## Script

### 0. Cold open (10s)

> "This is a privacy wallet for Stellar — passkeys instead of seed phrases,
> and two independent privacy rails: Confidential Transfers, and a Selective
> Privacy Pool. Both need infrastructure the public network doesn't provide
> on testnet — we built that too, and it's public for other builders to use."

### 1. Onboarding — Alice (30s)

1. Open the app fresh (Alice's profile). Click "Create a new wallet."
2. Passkey prompt — Face ID / Touch ID / platform authenticator. Narrate:
   "No seed phrase — this is a real Soroban smart account, secured by a
   passkey."
3. Wallet deploys, gets testnet-funded automatically (friendbot). Land on
   the forced backup-export screen — narrate briefly ("the app forces an
   encrypted backup before you can use it — this recovers both privacy
   rails' key material, not just the passkey") — export it, continue to the
   wallet home.

### 2. Confidential Transfers — Alice pays Bob (60-70s)

1. **Wallet tab** → "Activate confidential balance." Narrate while the proof
   generates: "This is a real zero-knowledge proof, generated right here in
   the browser — UltraHonk, via bb.js." Wait for "Activated · verified
   against chain."
2. Deposit some XLM (e.g. 100) — public → confidential. Point out the two
   numbers: Public XLM drops, Receiving goes up. "Merge" into spendable.
3. Switch to Bob's profile, also onboard + activate his own confidential
   balance (can be pre-recorded/sped up in editing — or do this before
   recording and just show Bob already activated, to keep runtime down).
4. Back on Alice: **Send confidentially** — paste Bob's `C…` address, amount
   (e.g. 40 XLM). Note the SendForm's live "Ready to receive confidential
   transfers" check before sending. Submit — another in-browser proof.
5. **Cut to the explorer tab**, the CT token contract, the just-submitted
   transaction. Narrate: "The transfer is on-chain — but the amount isn't.
   Everything here is ciphertext."
6. **Cut back to the wallet** (Alice's, then Bob's) — show both sides'
   decrypted balances updating (Alice's spendable down, Bob's receiving up
   by the same 40 XLM). "Both wallets independently decrypt the same
   on-chain ciphertext to the same number — that's the proof this isn't
   fake."

### 3. Selective Privacy Pool — Alice pays Carol (60-70s)

1. Switch to the **Shielded** tab. Narrate the session-account model in one
   sentence: "The pool signs with a plain Ed25519 key, so the wallet runs it
   through a dedicated session account — same backup file restores it, you
   never manage a second seed phrase."
2. "Create shielded session account," then move some public XLM into it,
   then **Shield** (e.g. 20 XLM) — narrate the proof generating (Groth16,
   the pool SDK's own prover worker this time — a different proving system
   from the CT rail's UltraHonk, on purpose, one per rail).
3. Switch to Carol's profile — she's already "Enabled receiving" (registered
   her shielded public keys) before this recording. Back on Alice: **Send
   shielded** to Carol's session address (e.g. 8 XLM). Submit.
4. **Cut to the explorer tab**, the SPP pool contract's recent transactions.
   Narrate: "There's a transaction here — but nothing on it says it's a
   payment, what it's for, or who's involved. No amount, no recognizable
   sender/recipient pattern. Only Alice and Carol's own wallets know what
   just happened."
5. **Cut back to Alice's wallet** — Unshield the remainder back to public
   XLM. Show the balance return to the smart account via "Return session XLM
   to wallet."

### 4. Unified activity — Activity tab (25-30s)

1. Switch to the **Activity** tab (Alice's wallet). Narrate: "One view, both
   rails: Confidential Token activity — register, deposit, the transfer to
   Bob — and the Selective Privacy Pool's public boundary events, shield and
   unshield. The private transfer to Carol never shows up here — staying
   invisible is the point of a shielded transfer, even to Alice's own
   unified history view; only the entry and exit are boundary events."
2. Point out this is served from **our own indexer**, not raw RPC: "Testnet
   RPC only keeps a few hours of history. This view — and the whole Shielded
   tab's sync — reads from our own Postgres-backed indexer instead, which is
   why it works past that window."

### 5. Compliance close (30-40s)

1. Narrate over the terminal (commands pre-typed, just hit enter):
   "Privacy without accountability isn't a real product — both rails have a
   compliance story."
2. **CT auditor channel**: "The Confidential Token contracts are deployed
   with an on-chain auditor key. The auditor's secret is held ops-side —
   never in this app, never committed to the repo — and can decrypt any
   transfer's amount independent of either party." Run (or show pre-run
   output of) `packages/ctd-sdk/test/auditor.mjs`'s decrypt path against the
   just-submitted transfer, or simply narrate over the code:
   `packages/ctd-sdk/src/auditor/` decrypting the transfer event's auditor
   ciphertext with `CT_AUDITOR_SECRET_HEX`.
3. **SPP ASP**: "The pool requires Association Set Provider approval before
   a shielded transaction goes through — that's the off-chain compliance
   gate; the app surfaces it directly if it isn't ready yet."
4. **Public bootnode**: `curl` the health endpoint on screen —

   ```bash
   curl -s https://api-production-70a0.up.railway.app/health
   ```

   Narrate: "This is the ONLY working bootnode for this pool's history
   anywhere right now — Nethermind's public one is dead. We recovered the
   pool's full history from a public archive and now serve it ourselves,
   live, for anyone building against this same pool." Point at the README's
   bootnode usage section briefly on screen.

### Close (10s)

> "Passkeys, two independent privacy rails, and the indexing infrastructure
> both actually need to work on testnet — all open, all documented, all live
> right now."

## Notes for whoever records this

- Pre-activate Bob's CT balance and Carol's SPP registration before hitting
  record, so the live recording doesn't spend time on two more onboarding
  flows — narrate that they're "already set up" rather than skip silently.
- If a proof step runs long on camera, cut and narrate over a sped-up clip —
  real UltraHonk/Groth16 proving takes a few seconds each, not instant.
- Keep the terminal commands for the compliance close pre-typed in a
  scratch file so nothing needs to be typed live.
