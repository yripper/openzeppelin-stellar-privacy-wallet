export const TESTNET = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  nativeSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  smartAccount: {
    accountWasmHash: "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a",
    webauthnVerifierAddress: "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F",
    ed25519VerifierAddress: "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4",
    relayerUrl: "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev",
  },
  spp: {
    /**
     * Our yield-bearing fork of the XLM shielded pool. Source:
     * `contracts/pool-yield/` (forked from
     * `vendor/stellar-private-payments/contracts/pool/`); deployment record:
     * `contracts/deployments/pool-yield-testnet.json`. Idle deposits above
     * `investThreshold` are batch-invested into `defindexVault` below
     * (`pool.rs`'s `collect_yield`/`get_surplus`/vault-invest path) rather
     * than sitting idle in the pool contract — everyone still holding a
     * pre-fork note keeps using `poolLegacy` instead. Max deposit per
     * transaction is 1000 XLM (`maxDepositStroops` below).
     */
    pool: "CC3AVJZR5MSOLLNNP7DYSG3KR7MTBE4N4VMAT5ZX4NWIJTQL75RNI3F5",
    /**
     * Nethermind's original XLM pool — what `pool` pointed at before the
     * yield fork. Kept enabled in the SDK manifest (not deployed/owned by
     * us) purely so pre-fork notes stay visible/spendable; new deposits go
     * to `pool` above.
     */
    poolLegacy: "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
    // EURC pool (the SDK's `all_contract_ids()` sync set's 2nd enabled pool) —
    // source: resources/stellar-private-payments/deployments/testnet/deployments.json
    // `pools[1].poolContractId`, cross-verified against the task-8.5 backfill
    // script's own hardcoded `POOL_EURC_CONTRACT_ID` (api/scripts/backfill-spp.ts),
    // now the single source of truth for it (Task 9).
    poolEurc: "CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74",
    publicKeyRegistry: "CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36",
    aspMembership: "CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K",
    aspNonMembership: "CBEPJBHP6X4K7KWLRPFUGPRS3OM6HWXTWIVN3M2LCGZZHCCTHHSYAAF3",
    /**
     * DeFindex vault `pool`'s idle liquidity is batch-invested into
     * (`pool.rs`'s `get_vault`/`DefindexVaultClient`, `vault` constructor
     * argument). Source: `contracts/deployments/pool-yield-testnet.json`,
     * cross-verified live via the `get_vault` smoke-test call (task-7).
     */
    defindexVault: "CAGNH456FTTMWEL26K7CGNVQABPB3SA5AV2YXU4R3XKUODEVU65ZN7Q7",
    // Earliest ledger of the sync set — the worker's `startLedger` must cover
    // both `pool` (deployed later, ledger 3968245) and `poolLegacy`/the other
    // pre-existing SPP contracts (deployed at this ledger), so this stays
    // pinned to the legacy pools' deployment ledger, not the yield pool's.
    deploymentLedger: 3773948,
    nethermindBootnode: "https://bootnode.dev-nethermind.xyz",
    /**
     * Per-transaction deposit ceiling of the yield `pool` above, in stroops
     * (1000 XLM). NOT a note denomination and not a total-balance cap — pool
     * notes hold arbitrary amounts, and you may deposit repeatedly. This is
     * OUR OWN `maximum_deposit_amount` constructor argument (we deployed this
     * pool, task-7), not read from chain storage the way the old comment
     * described for Nethermind's pool: `contracts/deployments/pool-yield-testnet.json`'s
     * `constructor.maximumDepositAmount` records the same `10000000000`
     * stroops passed at deploy. Enforced in `transact`,
     * `contracts/pool-yield/src/pool.rs:578-581` (`deposit_u > max` rejects
     * with `Error::WrongExtAmount`, code 6) — identical semantics to
     * Nethermind's original pool
     * (`resources/stellar-private-payments/contracts/pool/src/pool.rs:525-529`),
     * since `pool-yield` is a fork of it.
     */
    maxDepositStroops: 10_000_000_000n,
  },
  ct: {
    token: "CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH",
    verifier: "CBDQQ75BKSAO2TG4D37PKVJZ64F4Y3AHKTSY3NXV6DPEACSDWO4TBGQH",
    auditor: "CB27W7M4PLVGC77X5LPNZEOX5UCUWYJ3CODSBR6JR2WJEO66E4BGBDKA",
    underlying: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    deployedAtLedger: 3900251,
    auditorId: 0,
    addrF: "0x1c7eaa88b6e7b38066a07bfe60fc0da61efbce527e51267c124f94ecb258cb76",
  },
} as const;
