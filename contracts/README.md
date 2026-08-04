# contracts/

Deployment records for the Confidential Token (CT) contract suite this
monorepo consumes on Stellar testnet, plus the source and deployment
record for the `pool-yield` contract (see below). The CT suite's
directory holds **only the deployment artifact**
(`deployments/testnet.json`) — the Soroban contract source and WASM live
upstream (see Provenance) and are not vendored here.

## Provenance

The deployed contracts (`token`, `verifier`, `auditor`, `allowlist`,
`blocklist`, `factory`) are built from the WASM committed in
`brozorec/stellar-confidential-token-demo`, the same upstream this repo
vendors `@ctd/sdk` from (see `packages/ctd-sdk/ATTRIBUTION.md`). The demo
repo is cloned as a gitignored reference at
`resources/stellar-confidential-token-demo/` — nothing under `resources/`
is committed; only the resulting deployment addresses land here.

## Deploy procedure

Deploys are run **from inside the reference clone**, not from this repo,
using its own `pnpm install`/build artifacts and deploy script:

```bash
cd resources/stellar-confidential-token-demo
pnpm install
pnpm build:sdk
pnpm deploy:contracts   # runs scripts/deploy.ts
```

`scripts/deploy.ts` (upstream):

1. Deploys the native XLM Stellar Asset Contract as the underlying SEP-41
   asset (`contract asset deploy --asset native`).
2. Deploys `verifier`, `auditor`, `allowlist`, `blocklist`, then `token`
   (constructor wires `underlying_asset`/`verifier`/`auditor` together).
3. Registers the six circuit verification keys (register, withdraw,
   transfer, spender_transfer, set_spender, revoke_spender) in the
   verifier.
4. Registers one auditor Grumpkin key at id `0`.
5. Asserts the contract's on-chain `AddressAsField` (Poseidon2 of the
   token's address) equals the SDK's own `addressToField(token)` — the
   "addr_f parity guard". A mismatch here means the JS and Rust Poseidon2
   implementations have diverged and would break proof verification; the
   script throws rather than writing a broken deployment.
6. Uploads the four factory-deployable child WASMs and deploys `factory`.
7. Writes `deployments/testnet.json` (upstream shape:
   `resources/stellar-confidential-token-demo/scripts/_shared.ts:31-52`).

Deployer identity: the `admin` Stellar CLI key
(`stellar keys generate admin --network testnet --fund`, or
`stellar keys fund admin --network testnet` if it already exists but is
unfunded). The script hardcodes this identity name
(`resources/stellar-confidential-token-demo/scripts/deploy.ts:29`).

## Importing a fresh deploy into this repo

After a deploy, `resources/stellar-confidential-token-demo/deployments/testnet.json`
contains an `auditor.secretHex` field — the auditor's private scalar. This
must **never** be committed. To import:

1. Copy the file to `contracts/deployments/testnet.json`, **removing**
   `auditor.secretHex` from the `auditor` object (keep `id`, `keyXHex`,
   `keyYHex`).
2. Put the removed secret in the repo-root `.env` (gitignored) as
   `CT_AUDITOR_SECRET_HEX=<the secretHex value, 0x-prefixed>`. Add the bare
   key with an empty value to `.env.example`.
3. Copy `contracts.token`, `contracts.verifier`, `contracts.auditor`,
   `contracts.underlying`, `deployedAtLedger`, and `addrF` into the `ct`
   block of `packages/shared/src/config.ts`'s `TESTNET` export
   (`auditorId` is always `0` — the only auditor key id this deploy
   registers).
4. Rebuild: `pnpm --filter @privacy-wallet/shared build`.

## Current deployment

See `deployments/testnet.json` for the committed testnet addresses. As of
the most recent import (deployed at ledger `3900251`, admin
`GBB6XFESPZMKCBTKVGXEN3HN7P2VC57Q7C5E5GKT4CVCJROHEYJI2QJX`):

| Contract | Address |
|---|---|
| token | `CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH` |
| verifier | `CBDQQ75BKSAO2TG4D37PKVJZ64F4Y3AHKTSY3NXV6DPEACSDWO4TBGQH` |
| auditor | `CB27W7M4PLVGC77X5LPNZEOX5UCUWYJ3CODSBR6JR2WJEO66E4BGBDKA` |
| underlying (native SAC) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| allowlist | `CAQ3QLW435QWG2W5X3EFKBCHI5UUVMMMXQNMW2MB5WHOBGIECV7TXWDF` |
| blocklist | `CDLXJSWNI6CBIRBZE5ZU53LQTYYYLZ4WSGBQGGP43YR754RM6C5GTNOF` |
| factory | `CD6KN723TRLKMNHS6CFNMDEC4I6UWDKAXAFGMYU5NG5PQ7WMPL75IHTX` |

Only `token`, `verifier`, `auditor`, `underlying`, `deployedAtLedger`,
`auditorId`, and `addrF` are surfaced through `@privacy-wallet/shared`'s `ct`
block; `allowlist`/`blocklist`/`factory` are recorded in
`deployments/testnet.json` for completeness (advanced/factory-mode token
creation, not used by this monorepo yet) but are not part of the
`TESTNET.ct` interface.

## Verifying a deployment on-chain

There is no `auditor` read function on the token contract itself (the
contract only exposes state-changing entrypoints — `register`,
`deposit`, `withdraw`, `confidential_transfer`, etc. — plus
`confidential_balance`, which requires a registered account). To confirm
the deployment on-chain, read the token's instance storage directly, or
query the auditor contract's registered key:

```bash
# Token instance storage shows Auditor/Verifier/UnderlyingAsset/AddressAsField
stellar contract read --id <token> --network testnet --output json

# Auditor contract: registered Grumpkin key for id 0 (matches keyXHex||keyYHex)
stellar contract invoke --id <auditor> \
  --source-account GALAXYVOIDAOPZTDLHILAJQKCVVFMD4IKLXLSZV5YHO7VY74IWZILUTO \
  --network testnet --send no -- get_key --auditor_id 0
```

## pool-yield (yield-bearing SPP pool)

A yield-bearing variant of the Shielded Pool Protocol (SPP) pool contract:
source lives at `contracts/pool-yield/` and is fork provenance — a
verbatim copy of the vendored upstream pool
(`vendor/stellar-private-payments/contracts/pool`) plus an added
invest/divest/liability accounting layer (deposits above a threshold are
invested into a DeFindex vault; `get_surplus`/`collect_yield` let the
admin skim yield above the pool's liability floor). Unlike the CT suite
above, this contract's Rust source **is** vendored in this repo (not an
external reference clone), so `contracts/pool-yield/` is built and
deployed directly from here.

Deployment record: `deployments/pool-yield-testnet.json`.

The reused SPP shared infrastructure — the ZK verifier and the two ASP
(Association Set Provider) roots — is **not** a fresh deploy of this
task; it points at **Nethermind's existing testnet deployment** of those
contracts. The ASP addresses match `packages/shared/src/config.ts`'s
`TESTNET.spp` block exactly (`aspMembership`/`aspNonMembership`,
`config.ts:21-22`); the verifier address
(`CCNOLQUUPEZTPNZ7LMS3PYE5NVYNNTKTHJP7HDK4NJMH4JPKFP7HOHD4`) is
Nethermind's policy-suffix-"B" (blocklist) verifier, recorded upstream at
`vendor/stellar-private-payments/deployments/testnet/deployments.json:8`
but not currently surfaced in `config.ts`. The `token` argument is the
same native XLM SAC as the CT suite's `underlying` address above
(`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`).

### Build

```bash
cd contracts/pool-yield
VERIFIER_VK_JSON=<repo>/vendor/stellar-private-payments/testdata/selectiveDisclosure_1_vk.json \
  stellar contract build
```

`VERIFIER_VK_JSON` must point at a verification-key JSON file — the
build script embeds it into the compiled WASM; without it the build
fails. Produces `target/wasm32v1-none/release/pool_yield.wasm`.

### Deploy

Deployer identity: the `admin` Stellar CLI key (same identity that
deployed the CT suite above; `stellar keys address admin` prints its
G-address, `stellar keys fund admin --network testnet` tops it up if
unfunded).

```bash
cd contracts/pool-yield
stellar contract deploy \
  --wasm target/wasm32v1-none/release/pool_yield.wasm \
  --source-account admin --network testnet \
  -- \
  --admin "$(stellar keys address admin)" \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --verifier CCNOLQUUPEZTPNZ7LMS3PYE5NVYNNTKTHJP7HDK4NJMH4JPKFP7HOHD4 \
  --asp_membership CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K \
  --asp_non_membership CBEPJBHP6X4K7KWLRPFUGPRS3OM6HWXTWIVN3M2LCGZZHCCTHHSYAAF3 \
  --maximum_deposit_amount 10000000000 \
  --levels 10 \
  --policy_flags 2 \
  --vault CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7 \
  --invest_threshold 10000000000 \
  --liquidity_buffer 2000000000
```

`--levels 10` was verified against the live upstream pool
(`CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI`, the `spp.pool`
address in `config.ts`) before deploying, by reading its persistent
contract-data entry keyed `ScVal::Vec([Symbol("Levels")])` — returned
`scvU32 10`, confirming the merkle tree depth used across the wallet's
SPP integration is safe to reuse here.

### Smoke test

```bash
stellar contract invoke --id <POOL_YIELD_ID> --source-account admin --network testnet --send no -- get_vault
stellar contract invoke --id <POOL_YIELD_ID> --source-account admin --network testnet --send no -- get_invest_params
stellar contract invoke --id <POOL_YIELD_ID> --source-account admin --network testnet --send no -- get_liabilities
stellar contract invoke --id <POOL_YIELD_ID> --source-account admin --network testnet --send no -- get_surplus
stellar contract invoke --id <POOL_YIELD_ID> --source-account admin --network testnet --send no -- get_policy_flags
stellar contract invoke --id <POOL_YIELD_ID> --source-account admin --network testnet --send no -- get_root
```

Expected (and confirmed against the current deployment in
`deployments/pool-yield-testnet.json`): `get_vault` = `CAGNH…N7Q7`,
`get_invest_params` = `["10000000000","2000000000"]`, `get_liabilities` =
`0`, `get_surplus` = `0`, `get_policy_flags` = `2`, and `get_root` a
nonzero value (the empty-tree root for a 10-level merkle tree).
