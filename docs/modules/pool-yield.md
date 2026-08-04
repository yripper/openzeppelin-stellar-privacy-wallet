# pool-yield Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `contracts/pool-yield/` · **Last verified:** 2026-08-04

## Purpose

A yield-bearing fork of the Shielded Pool Protocol (SPP) pool contract
(`vendor/stellar-private-payments/contracts/pool`). The transaction-privacy
core (Merkle tree of commitments, nullifier set, Groth16 proof verification,
ASP membership/non-membership policy) is copied verbatim from upstream; on
top of it this fork adds an invest/divest/liability-accounting layer so idle
deposits earn yield instead of sitting in the pool contract doing nothing:

- Deposits above a threshold are batch-invested into a **DeFindex** vault
  (`DefindexVaultClient`, `pool.rs:172-192`).
- A running **liability** counter (`TotalLiabilities`) tracks exactly how
  many stroops are backed by outstanding notes.
- `get_surplus`/`collect_yield` let the admin skim only the amount above
  that liability floor — note-backed funds are structurally unreachable by
  the yield-collection path (see Gotchas).

Deployed to Stellar testnet: `CC3AVJZR5MSOLLNNP7DYSG3KR7MTBE4N4VMAT5ZX4NWIJTQL75RNI3F5`
(ledger 3968245, `contracts/deployments/pool-yield-testnet.json`). Invests
into DeFindex vault `CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7`.
Deployed with `investThreshold = 10_000_000_000` stroops (1000 XLM),
`liquidityBuffer = 2_000_000_000` stroops (200 XLM), `maximumDepositAmount =
10_000_000_000` stroops (1000 XLM per transaction).

Nethermind's original (non-yield) pool,
`CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI`, stays live
(`TESTNET.spp.poolLegacy`, `packages/shared/src/config.ts`) purely so
pre-fork notes stay visible/spendable — it is not part of this module, no
source lives here for it, and it is not invested into anything. New
deposits go to this fork's pool.

## Structure

| File | Purpose |
|---|---|
| `contracts/pool-yield/Cargo.toml` | Crate manifest; path deps on `vendor/stellar-private-payments/contracts/{types,soroban-utils}`. |
| `contracts/pool-yield/src/lib.rs` | Crate entry, re-exports. |
| `contracts/pool-yield/src/pool.rs` | The contract: forked-verbatim privacy-pool logic (`transact`/`internal_transact`, proof verification, ASP root checks) plus the added invest/divest/liability layer (`pool.rs:1060` onward, and the `TotalLiabilities`/`Vault`/`InvestThreshold`/`LiquidityBuffer` storage/logic threaded through `__constructor` and `internal_transact`). |
| `contracts/pool-yield/src/merkle_with_history.rs` | Commitment Merkle tree — forked verbatim, untouched by this fork's yield work. |
| `contracts/pool-yield/src/policy.rs` | ASP policy-flag bitset helpers — forked verbatim. |
| `contracts/pool-yield/src/test.rs` | 37 unit tests: the forked privacy-pool suite plus this fork's own (liabilities accounting, invest threshold/buffer, divest-on-demand, `collect_yield`/`get_surplus`/`update_invest_params`, constructor validation) — includes `mod mock_vault` (a `MockVault` test double for `DefindexVaultClient`) and `mod mock_verifier`. |
| `contracts/deployments/pool-yield-testnet.json` | Testnet deployment record — network, `deployedAtLedger`, contract address, and the full constructor argument set. |
| `contracts/README.md` | Build/deploy/smoke-test procedure — see its "pool-yield (yield-bearing SPP pool)" section. |

## Public surface

Every `pub fn` inside `#[contractimpl] impl PoolContract` (`pool.rs:259-1123`)
is an invocable contract method. Forked-verbatim ones (unchanged behavior
from upstream): `__constructor` (`pool.rs:283`, extended with the vault
args — see Key methods), `transact` (`pool.rs:565`), `get_policy_flags`
(`pool.rs:751`), `get_root` (`pool.rs:763`), `is_known_root` (`pool.rs:773`),
`is_spent` (`pool.rs:789`), `update_admin` (`pool.rs:959`),
`update_asp_membership` (`pool.rs:994`), `update_asp_non_membership`
(`pool.rs:1012`), `get_asp_membership_root` (`pool.rs:1036`),
`get_asp_non_membership_root` (`pool.rs:1054`). The yield layer this fork
adds is listed in Key methods below.

## Key methods (`file:line`) — the invest/divest/liability layer

- `__constructor` (`pool.rs:283-334`) — same upstream args plus `vault:
  Address`, `invest_threshold: i128`, `liquidity_buffer: i128`. Validates
  `invest_threshold > 0`, `liquidity_buffer >= 0`, and `liquidity_buffer <
  invest_threshold` (`pool.rs:318-320`), rejecting with
  `Error::InvalidInvestParams` (code 15) otherwise. Initializes
  `TotalLiabilities` to `0` (`pool.rs:328`).
- `internal_transact` (`pool.rs:613-707`) — the added calls, in order: on a
  withdrawal (`ext_amount < 0`), `ensure_idle` (`pool.rs:672`) before the
  payout transfer, then `sub_liabilities` (`pool.rs:674`) after it; on a
  deposit (`ext_amount > 0`), `add_liabilities` (`pool.rs:702`) then
  `maybe_invest` (`pool.rs:703`), both **after** the commitment events are
  published.
- `get_vault` (`pool.rs:795-800`) — the DeFindex vault address.
- `get_invest_params` (`pool.rs:803-815`) — `(invest_threshold,
  liquidity_buffer)` in stroops.
- `get_liabilities` (`pool.rs:818-824`) — note-backed stroops (Σ deposits −
  Σ withdrawals), defaulting to `0` if never set.
- `add_liabilities` (`pool.rs:827-832`, private) — checked-add; overflow
  returns `Error::Overflow`.
- `sub_liabilities` (`pool.rs:837-841`, private) — **saturating**
  (`.max(0)`), documented in-source as "a pre-fork accounting gap must never
  brick withdrawals."
- `authorize_vault_pull` (`pool.rs:846-864`, private) — pre-authorizes the
  vault's nested `token.transfer(pool → vault, amount)` via
  `env.authorize_as_current_contract` so `vault.deposit(from = pool)` can
  pull the funds without a second signature.
- `ensure_idle` (`pool.rs:870-923`, private) — guarantees at least
  `required` idle stroops before a payout; if the pool's own balance falls
  short, divests `deficit + buffer` worth of vault shares (priced via
  `get_asset_amounts_per_shares`, clamped to the pool's actual share
  balance). Returns `Err(Error::VaultDivestFailed)` (code 16) on any
  failure — **fatal**, unlike `maybe_invest` below (see Gotchas).
- `maybe_invest` (`pool.rs:928-948`, private) — batch-invests idle balance
  above `liquidity_buffer` once idle `>= invest_threshold`; bails silently
  (`let-else` / `let _ =`) on any missing config or vault failure — **never
  fatal** (see Gotchas).
- `vault_position_value` (`pool.rs:1063-1071`, private) — current value of
  the pool's vault share balance, in asset stroops.
- `get_surplus` (`pool.rs:1076-1083`) — `(idle + vault_position −
  liabilities).max(0)`. The **only** amount `collect_yield` may ever pay.
- `collect_yield` (`pool.rs:1088-1103`) — admin-only
  (`get_admin(&env)?.require_auth()`, `pool.rs:1089`); calls `ensure_idle`
  for the surplus, recomputes `get_surplus` **after** the divest (so price
  rounding during the divest can never pay out of liabilities), pays
  `min(recomputed_surplus, actual_idle_balance)` to `to`, returns the
  amount paid (`0` if surplus was `<= 0`).
- `update_invest_params` (`pool.rs:1106-1122`) — admin-only; re-validates
  the same threshold/buffer invariant as the constructor.

## Dependencies

- `vendor/stellar-private-payments/contracts/{types,soroban-utils}` — path
  deps (`Cargo.toml`); `Groth16Error`/`Groth16Proof` and
  `soroban_utils::constants::bn256_modulus`/`update_admin`.
- Two contracts this pool does **not** own or deploy: the ZK verifier
  (`CCNOLQUUPEZTPNZ7LMS3PYE5NVYNNTKTHJP7HDK4NJMH4JPKFP7HOHD4`) and both ASP
  roots — all three are Nethermind's existing testnet deployment
  (`contracts/README.md`'s "pool-yield" section).
- The DeFindex vault (`CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7`)
  — called through the hand-declared `DefindexVaultInterface`/
  `DefindexVaultClient` (`pool.rs:172-192`: `deposit`, `withdraw`,
  `balance`, `get_asset_amounts_per_shares`), also the vault's own SEP-41
  share token.
- `token` (native XLM SAC, `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`)
  — the same underlying asset the Confidential Token suite uses (unrelated
  otherwise).
- Consumed by: `api/src/worker.ts`'s `buildSppContractIds()` (indexes this
  pool's `NewCommitmentEvent`/`NewNullifierEvent`) and `app/src/lib/spp.ts`
  (`account.pool({poolContract: TESTNET.spp.pool})`) — see `api.md`/`app.md`.

## Gotchas & invariants

- **The balance-sheet invariant, and why `collect_yield` can never pay
  note-backed funds.** `get_surplus` (`pool.rs:1076-1083`) is `(idle_token_balance
  + vault_position_value − TotalLiabilities).max(0)`. `TotalLiabilities`
  only grows on a deposit (`add_liabilities`, `pool.rs:702`) and only
  shrinks on a withdrawal (`sub_liabilities`, `pool.rs:674`) — it is never
  touched by `maybe_invest`/`ensure_idle`/`collect_yield` themselves. Since
  `idle + vault_position` is the pool's total real assets, subtracting
  liabilities and clamping at `0` means `collect_yield` structurally cannot
  transfer more than "assets minus what's owed to depositors," regardless
  of what value it's called with or how many times.
- **Invest failures are swallowed; divest failures are fatal — asymmetric
  on purpose.** `maybe_invest` (`pool.rs:928-948`) uses `try_deposit` and
  discards the result (`let _ = ...`), and even bails via `let-else` before
  attempting anything if `get_token`/`get_vault`/`get_invest_params` fail —
  a vault outage or misconfiguration must never block a user's deposit.
  `ensure_idle` (`pool.rs:870-923`), used by both withdrawals and
  `collect_yield`, does the opposite: any failure (no vault shares, a
  failed price probe, a failed `try_withdraw`, or insufficient balance even
  after divesting) returns `Err(Error::VaultDivestFailed)` — a withdrawal
  must never be paid short or silently dropped.
- **No new contract events, and none should ever be added.** This fork's
  entire invest/divest/liability layer (`maybe_invest`, `ensure_idle`,
  `add_liabilities`/`sub_liabilities`, `collect_yield`,
  `update_invest_params`) publishes nothing — the only two events the
  contract emits are the forked-verbatim `NewCommitmentEvent`/
  `NewNullifierEvent` (`pool.rs:228-249`). This is required, not a style
  choice: the SPP SDK's event parser
  (`vendor/stellar-private-payments/sdk/state/src/events_parsers.rs:11-38`)
  matches event names against a fixed list (`new_nullifier_event`,
  `new_commitment_event`, `public_key_event`, `leaf_added`, `leaf_inserted`,
  `leaf_updated`, `leaf_deleted`) and its catch-all arm
  (`events_parsers.rs:37`) returns `Err(anyhow!("unhandled event {}",
  parsed.name))` for anything else — an unrecognized event name would break
  the client's sync loop, not just go unread.
- **Unit tests run under `mock_all_auths()` — they do not prove
  `authorize_vault_pull`'s auth-entry shape works against Soroban's real
  auth engine.** `setup_yield_pool` (`test.rs:1192`) calls
  `env.mock_all_auths()` before every yield test, so
  `authorize_as_current_contract` (`pool.rs:848-863`) is exercised for
  control flow only in the unit suite. What actually proves the real
  network accepts that entry shape is the live testnet run: the six-call
  smoke test after deploy (task-7 report) and the full shield/unshield/send
  round-trip through the wallet's C-signer fork (`README.md`'s "The SPP
  session signer" section, txns `352efbca…`/`e5e2a26a…`/`b443e940…`).
- **Batching is for gas + liquidity buffer, not extra privacy.**
  `maybe_invest` only fires once idle `>= invest_threshold` (`pool.rs:937`),
  so multiple users' deposits land in the pool contract's balance and get
  invested together in one vault call rather than one vault call per
  deposit. This saves gas and avoids constantly toggling small amounts in
  and out of the vault — it does **not** add privacy. Every SPP deposit's
  `ext_amount` is already a public input to the proof
  (`hash_ext_data`/`calculate_public_amount`, `pool.rs:142-150,377-397`) and
  the transaction itself is a public on-chain event; batching the resulting
  idle balance's investment timing reveals nothing about individual
  deposits that wasn't already public per-transaction.
- **Per-user yield is impossible without new circuits — note amounts are
  sealed.** `Proof.output_commitment0`/`output_commitment1` (`pool.rs:97-100`)
  are opaque `U256` field elements; the amount inside a note never appears
  in cleartext on-chain (only the pool-wide `ext_amount` at
  deposit/withdrawal boundaries does). `TotalLiabilities` and `get_surplus`
  are therefore necessarily **pool-wide aggregates** — the contract has no
  way to attribute accrued yield to a specific depositor or note, and
  `collect_yield` pays a lump sum to the admin, never a per-user amount. A
  future hardening option raised in design review — fixed-denomination
  shields (notes minted only in a small set of standard sizes, the way
  Tornado-Cash-style pools work) — could let a note's denomination alone
  hint at a yield-eligible principal without decrypting its contents, but
  no such circuit change exists in this fork.
- **Constructor validation is strict and shared with `update_invest_params`.**
  Both reject `invest_threshold <= 0`, `liquidity_buffer < 0`, or
  `liquidity_buffer >= invest_threshold` with `Error::InvalidInvestParams`
  (`pool.rs:318-320` and `1112-1113`, identical condition). The deployed
  instance uses `invest_threshold = 1000 XLM`, `liquidity_buffer = 200
  XLM` — buffer strictly less than threshold, as required.
- **`VERIFIER_VK_JSON` is required to build or test this crate.**
  `cargo test`/`cargo build`/`stellar contract build` all fail without it —
  a build-script requirement inherited from the forked
  `circom-groth16-verifier` dev-dependency, which embeds the Groth16
  verification key as static bytes at compile time. Exact invocation used
  throughout this feature's tasks 1-7 (`task-1-report.md`'s "VERIFIER_VK_JSON
  Environment Variable" section):
  `VERIFIER_VK_JSON=<repo>/vendor/stellar-private-payments/testdata/selectiveDisclosure_1_vk.json cargo test`.
- **`--levels 10` at deploy time is not arbitrary** — it must match the
  Merkle tree depth already live on `poolLegacy`
  (`CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI`'s on-chain
  `Levels` storage entry, verified `10` in task-7). A mismatched depth would
  silently break root/proof compatibility with the rest of the SPP client
  code, which is written for depth-10 trees.
- **Redeploys are not idempotent.** Same as the CT suite and the rest of
  `contracts/` (`contracts.md`'s Gotchas) — a fresh `stellar contract
  deploy` mints a new C-address and ledger every time;
  `contracts/deployments/pool-yield-testnet.json` must be regenerated, not
  hand-edited.

## Testing

- **37/37 Rust unit tests** (`cargo test` from `contracts/pool-yield/`,
  `VERIFIER_VK_JSON` set as above) — covers the forked privacy-pool
  behavior plus this fork's own: deposit/withdraw liabilities accounting,
  invest-threshold/buffer batching (incl. a below-threshold no-op case and
  a swallowed-vault-failure case), divest-on-demand with buffer refill
  (incl. a fatal-divest-failure case), `collect_yield`/`get_surplus`/
  `update_invest_params` (incl. admin-auth-required, no-surplus-pays-zero,
  and invalid-params-rejected cases), and constructor validation. Uses a
  `MockVault`/`MockVerifier` test double pair (`test.rs`'s `mod mock_vault`/
  `mod mock_verifier`) plus a real SAC token, not the live DeFindex/verifier
  contracts.
- **On-chain smoke test after deploy** (task-7 report): six read-only
  `stellar contract invoke --send no` calls — `get_vault`,
  `get_invest_params`, `get_liabilities`, `get_surplus`, `get_policy_flags`,
  `get_root` — all matched expected values against a freshly-deployed,
  empty pool (`get_liabilities`/`get_surplus` both `0`, `get_invest_params`
  `["10000000000","2000000000"]`).
- **Live testnet round-trip through the wallet** (`README.md`'s "The SPP
  session signer" section, 2026-08-04): register, shield 5 XLM, unshield 2
  XLM, shielded send 1 XLM — real transactions
  (`352efbca…`/`e5e2a26a…`/`b443e940…`) against this exact deployed
  contract via the C-signer fork, public balance exactly consistent
  (`10,000 → 9,997 XLM`). This is the run that actually proves
  `authorize_vault_pull`'s auth-entry shape works against Soroban's real
  auth engine (see Gotchas) — the unit suite runs under `mock_all_auths()`
  and cannot prove that by itself.
