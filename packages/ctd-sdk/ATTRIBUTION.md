# Attribution

This package (`@ctd/sdk`) is vendored from the `packages/sdk` directory of:

- **Upstream repo:** [`brozorec/stellar-confidential-token-demo`](https://github.com/brozorec/stellar-confidential-token-demo)
- **Vendored commit:** `ac67499a617c084b80c0e0298180b2c4faf9e2fb`
- **Upstream path:** `packages/sdk`
- **License:** `MIT` per the upstream root `package.json` (`"license": "MIT"`). No standalone `LICENSE` file was present in the upstream repo at the vendored commit; original license terms apply regardless.

`@ctd/sdk` is not published to npm (verified 404 for the package name) — Tasks 4 and 11 in this monorepo depend on its proving/witness/encoding exports, so it is vendored in-tree instead of installed.

## Why vendored, not a git submodule/subtree

The hackathon timeline needs the package to build and version-pin (`@stellar/stellar-sdk`) independently of the upstream repo's own lockfile/workspace, and the upstream repo itself (`resources/stellar-confidential-token-demo/`) is gitignored scratch material in this monorepo — only this vendored copy is tracked.

## What was copied

Everything under upstream `packages/sdk/`: `src/`, `circuits/` (including `circuits/vks/*.vk.bin`), `contracts/*.wasm`, `test/`, `package.json`, `tsconfig.json`, `README.md`. No `node_modules/` or `dist/` existed in the upstream directory at copy time, so nothing was excluded.

## Local modifications

Keep this list current — one entry per change made to vendored files, in this repo, since the copy above.

1. **`package.json`** — bumped `"@stellar/stellar-sdk"` from `"^14.2.0"` to `"16.2.0"` (exact pin) to match the version this monorepo standardizes on for every package.

No source-code fixes were required by the 14→16 bump: `pnpm --filter @ctd/sdk build` (`tsc -p tsconfig.json`) compiled clean with zero errors. The package's stellar-sdk usage is shallow — `Address`, `xdr` (`xdr.ScVal`, `nativeToScVal`, `scValToNative`), `rpc` (`src/chain/events.ts`, `src/chain/client.ts`) — all stable across the two major versions for these call sites.

## Upstream README

The vendored `README.md` (`packages/ctd-sdk/README.md`) is upstream's own package doc and is left as-is (it references sibling packages `@ctd/disclosure` / `@ctd/indexer` that are not part of this vendored copy — those references are inert prose, not imports; see `docs/modules/ctd-sdk.md` for what's actually usable from this repo).
