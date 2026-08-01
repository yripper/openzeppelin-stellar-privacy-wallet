# Module Documentation Index

Living docs — one per module. **Read the relevant doc before modifying a module; update it in the same change.** See the "Module Documentation Convention" section in `CLAUDE.md` for the workflow.

| Doc | Module | One-liner |
|---|---|---|
| [shared.md](shared.md) | `packages/shared/` | `@grantfox/shared` — TESTNET network/contract config consumed by every other package |
| [ct-tx.md](ct-tx.md) | `packages/shared/src/ct-tx.ts`, `scripts/smoke-ct.ts` | Confidential Token invoke glue (`buildCtInvokeTx`) + the C-address smart-account lifecycle smoke (gate #1) |
| [ctd-sdk.md](ctd-sdk.md) | `packages/ctd-sdk/` | `@ctd/sdk` — vendored Confidential Token client SDK (witness building, UltraHonk proving, chain/state sync) |
| [contracts.md](contracts.md) | `contracts/` | Confidential Token contract suite deployment record (testnet) + deploy/import procedure |
| [api.md](api.md) | `api/` | `@grantfox/api` — Postgres schema (`events`, `ct_activity`, `cursors`, `bootnode_pages`) + `createDb`/`IndexerRepo` data-access surface for the indexer worker, normalizer, and REST/bootnode API server (CORS-enabled for the browser wallet) |
| [app.md](app.md) | `app/` | `@grantfox/app` — Vite + React 19 wallet frontend: passkey smart-account onboarding, privacy bundle (CT keys + SPP root secret) + encrypted backup, and both privacy rails — Confidential Token (register/deposit/merge/send/withdraw, in-browser UltraHonk proving, activity feed) and Shielded Pool (session-signer SPP: fund/shield/send/unshield/sweep, Groth16 proving, history synced through our own `/rpc` bootnode) |
