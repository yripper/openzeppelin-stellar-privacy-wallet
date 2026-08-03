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
    pool: "CAWCZ6EO4PM5EZOH5K7XSW3R46DGLOT3XSEH36OA5EOZUSJ5XS7BX6XI",
    // EURC pool (the SDK's `all_contract_ids()` sync set's 2nd enabled pool) —
    // source: resources/stellar-private-payments/deployments/testnet/deployments.json
    // `pools[1].poolContractId`, cross-verified against the task-8.5 backfill
    // script's own hardcoded `POOL_EURC_CONTRACT_ID` (api/scripts/backfill-spp.ts),
    // now the single source of truth for it (Task 9).
    poolEurc: "CAJJT5YV4BMFTHEOO5FGO2G56TEJKM4G4FW7FS4DYBLLLLHSAYUZWT74",
    publicKeyRegistry: "CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36",
    aspMembership: "CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K",
    aspNonMembership: "CBEPJBHP6X4K7KWLRPFUGPRS3OM6HWXTWIVN3M2LCGZZHCCTHHSYAAF3",
    deploymentLedger: 3773948,
    nethermindBootnode: "https://bootnode.dev-nethermind.xyz",
    /**
     * Per-transaction deposit ceiling of the XLM `pool` above, in stroops
     * (100 XLM). NOT a note denomination and not a total-balance cap — pool
     * notes hold arbitrary amounts, and you may deposit repeatedly. It is the
     * `maximum_deposit_amount` constructor argument Nethermind chose when they
     * deployed this pool, enforced in `transact`:
     * `resources/stellar-private-payments/contracts/pool/src/pool.rs:525-529`
     * rejects `ext_amount > max` with `Error::WrongExtAmount` (code 6).
     *
     * The pool exposes no getter for it (`get_maximum_deposit` is private,
     * pool.rs:659), so this is read straight from contract storage. Re-verify
     * with a `getLedgerEntries` call on the persistent contract-data key
     * `ScVal::Vec([Symbol("MaximumDepositAmount")])` against `pool` — verified
     * 2026-08-03 on testnet, returned `scvU256` 1000000000.
     */
    maxDepositStroops: 1_000_000_000n,
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
