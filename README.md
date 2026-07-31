# GrantFox Privacy Wallet

A Stellar wallet + indexer combining Confidential Transfers (CT) and a Selective Privacy Pool (SPP) for private, compliant payments.

## Monorepo layout

```
app/               # frontend wallet app (added in a later task)
api/               # backend API + indexer worker (added in a later task)
packages/shared/   # @grantfox/shared — TESTNET network/contract config, shared types
docs/modules/       # living per-module docs (see CLAUDE.md)
```

## Requirements

- Node >= 22
- pnpm >= 10
- Docker (for local Postgres via `docker-compose.yml`)

## How to run

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # run all package tests

docker compose up -d postgres   # local Postgres (see .env.example for connection vars)
```

See `docs/modules/README.md` for the per-module documentation index.
