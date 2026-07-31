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
    publicKeyRegistry: "CDK75EQA2G4EDN34CWY7ALJ4EIQMNVBOFMHAVIF3BBY7IUDNHKHNDA36",
    aspMembership: "CDEFDJPNVWDWUUHGHGGZ56FEPSSJHQLGRKS6OWIRKGRYRWSBNMLW7J5K",
    aspNonMembership: "CBEPJBHP6X4K7KWLRPFUGPRS3OM6HWXTWIVN3M2LCGZZHCCTHHSYAAF3",
    deploymentLedger: 3773948,
    nethermindBootnode: "https://bootnode.dev-nethermind.xyz",
  },
} as const;
