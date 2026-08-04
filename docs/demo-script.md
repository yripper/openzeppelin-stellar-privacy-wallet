# Demo video script

Target length: 3.5-4.5 minutes. Story: *cold open on the landing page → Alice
onboards with a passkey → CT: activate privacy, deposit, private send to Bob
(explorer shows no amount, wallet shows decrypted) → SPP: shield straight from
the smart account (our SDK fork), private transfer to Carol, unshield
(explorer shows nothing linking) → the yield beat: pool stats card, harvest,
accrued yield ticks up live → activity history served from our indexer past
RPC retention → compliance close: auditor channel + ASP + public bootnode.*

## Before recording — have these open

- **Tabs**: the wallet app (three separate browser profiles/windows, one per
  persona below, so each keeps its own passkey — Chrome profiles or three
  separate browser contexts work), plus
  [stellar.expert testnet explorer](https://stellar.expert/explorer/testnet).
- **Wallet app**: https://app-production-2f5e.up.railway.app — it now opens on
  the full landing page (hero, "what the ledger sees" figure, yield story),
  which is the cold open.
- **CT token contract on the explorer** (for the "explorer shows no amount"
  beat): https://stellar.expert/explorer/testnet/contract/CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH
- **Yield pool contract on the explorer** (for the "explorer shows nothing
  linking" beat — this is OUR fork, where all new deposits go):
  https://stellar.expert/explorer/testnet/contract/CC3AVJZR5MSOLLNNP7DYSG3KR7MTBE4N4VMAT5ZX4NWIJTQL75RNI3F5
- **API health / bootnode**, for the compliance close:
  https://api-production-70a0.up.railway.app/health and
  https://api-production-70a0.up.railway.app/rpc
- Three personas, each their own browser profile so passkeys don't collide:
  **Alice** (sender), **Bob** (CT recipient), **Carol** (SPP recipient).
- A terminal with the yield + compliance commands pre-typed in a scratch
  file (exact commands below) so nothing is typed live. The yield commands
  need the `stellar` CLI with the `admin` identity configured (the same
  machine that deployed the pool has it).

## Script

### 0. Cold open — the landing page (15s)

Start on https://app-production-2f5e.up.railway.app scrolled to the top.
Slow-scroll past the hero and the "What the public ledger sees" figure while
narrating:

> "This is a privacy wallet for Stellar — passkeys instead of seed phrases,
> two independent privacy rails, and a shielded pool whose idle liquidity
> earns yield in DeFindex. Everything you'll see is live on testnet right
> now."

### 1. Onboarding — Alice (30s)

1. Click **Create a new wallet** (the landing repeats the button, use
   whichever is on screen). Passkey prompt — Face ID / Touch ID. Narrate:
   "No seed phrase — this is a real Soroban smart account, secured by a
   passkey."
2. Wallet deploys, gets testnet-funded automatically (friendbot). Land on
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
   balance (pre-record or do before recording and just show Bob already
   activated, to keep runtime down).
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

### 3. Shielded pool — Alice pays Carol, as her smart account (60s)

1. Switch to the **Shielded** tab. While it connects, narrate the fork —
   this is a brag now, not a caveat: "The stock pool SDK only speaks classic
   Ed25519 accounts, so every wallet built on it needs a throwaway side
   account. We forked the SDK: the smart account itself is the pool
   identity. Same passkey, no second account, no extra funding step."
2. **Shield** (e.g. 100 XLM) — it pulls straight from the smart account's
   public balance, authorized by the passkey. Narrate the proof (Groth16,
   the pool SDK's own prover worker — a different proving system from the
   CT rail's UltraHonk, on purpose, one per rail).
3. Switch to Carol's profile — she's already enabled receiving (registered
   her shielded public keys, by her own wallet `C…` address) before this
   recording. Back on Alice: **Send shielded** to Carol's wallet `C…`
   address (e.g. 8 XLM). Submit.
4. **Cut to the explorer tab**, the yield pool contract's recent
   transactions. Narrate: "There's a transaction here — but nothing on it
   says it's a payment, what it's for, or who's involved. No amount, no
   recognizable sender/recipient pattern. Only Alice and Carol's own
   wallets know what just happened."
5. **Cut back to Alice's wallet** — Unshield part of the rest (e.g. 50 XLM).
   It pays straight back to the smart account's public balance; show Public
   XLM tick back up.

### 4. The yield beat — the pool earns its keep (35-45s)

1. Still on the **Shielded** tab, scroll to the **Pool stats** card.
   Narrate: "These are the pool's public aggregates — what it owes
   depositors, idle liquidity, what's earning in a DeFindex vault, and the
   accrued yield. We forked the pool contract: once idle deposits cross
   1,000 XLM they batch-invest into DeFindex, and withdrawals divest in the
   same transaction — depositors never wait."
2. **Terminal**: realize yield on the vault's strategy (permissionless),
   pre-typed:

   ```bash
   stellar contract invoke \
     --id CADHRSHEUSPUPG7F5UPT5OQ5ALNODBNVX7IXKXF2ZZAPTXSIWR36FLUN \
     --source admin --network testnet \
     -- harvest --from CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7
   ```

3. Back in the app, hit the card's **Refresh** — "Accrued yield" ticks up on
   camera. Narrate the invariant: "The contract tracks exactly what it owes
   depositors, and the collect function can only pay out the surplus above
   that number — depositor principal is protected by arithmetic, not by an
   admin promise. That surplus is the service fee that funds the project."
4. Optional (if runtime allows) — collect it live as the operator:

   ```bash
   stellar contract invoke \
     --id CC3AVJZR5MSOLLNNP7DYSG3KR7MTBE4N4VMAT5ZX4NWIJTQL75RNI3F5 \
     --source admin --network testnet \
     -- collect_yield --to GBB6XFESPZMKCBTKVGXEN3HN7P2VC57Q7C5E5GKT4CVCJROHEYJI2QJX
   ```

   Refresh the card again: accrued yield returns to ~0, owed-to-depositors
   unchanged. (Yield on the demo strategy accrues per unit time, so the
   amount will be small minutes after a harvest — the mechanism, not the
   amount, is the point; say so.)

### 5. Unified activity — Activity tab (25s)

1. Switch to the **Activity** tab (Alice's wallet). Narrate: "One view, both
   rails: Confidential Token activity — register, deposit, the transfer to
   Bob — and the shielded pool's public boundary events, shield and
   unshield. The private transfer to Carol never shows up here — staying
   invisible is the point, even in Alice's own history; only the entry and
   exit are boundary events."
2. Point out this is served from **our own indexer**, not raw RPC: "Testnet
   RPC only keeps a few hours of history. This view — and the whole Shielded
   tab's sync — reads from our own Postgres-backed indexer instead, which is
   why it works past that window."

### 6. Compliance close (30-40s)

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

> "Passkeys, two privacy rails, a shielded pool that pays for itself, and
> the indexing infrastructure it all actually needs on testnet — all open,
> all documented, all live right now."

## Notes for whoever records this

- Pre-activate Bob's CT balance and Carol's shielded registration before
  hitting record, so the live recording doesn't spend time on two more
  onboarding flows — narrate that they're "already set up" rather than skip
  silently.
- Shield amounts are capped at 1,000 XLM per transaction (the pool's
  `maximumDepositAmount`).
- Optional bigger yield beat: shield 600 XLM twice from Alice instead of
  100 once — the second shield crosses the 1,000 XLM invest threshold and
  the Pool stats card's "Earning in DeFindex" jumps on the next refresh,
  showing the batch-invest live. Costs ~30s of runtime and a second proof.
- Run the `harvest` command a beat BEFORE showing the Pool stats card if
  you want "Accrued yield" already non-zero on first reveal, then harvest
  again for the on-camera tick. Yield on the demo strategy accrues with
  time elapsed, so amounts minutes after deployment/collection are small —
  narrate that the mechanism is the point.
- If a proof step runs long on camera, cut and narrate over a sped-up clip —
  real UltraHonk/Groth16 proving takes a few seconds each, not instant.
- Keep the terminal commands for the yield beat and compliance close
  pre-typed in a scratch file so nothing needs to be typed live.
