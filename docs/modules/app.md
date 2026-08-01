# app Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `app/` · **Last verified:** 2026-08-01 (Task 10)

## Purpose

`@grantfox/app` — the browser wallet frontend. Task 10 scaffolds the Vite +
React 19 + react-router SPA and its passkey onboarding flow: create a
smart-account wallet with a WebAuthn passkey (`smart-account-kit`), fund it
on testnet, mint a local "privacy bundle" (Confidential Token keys + SPP root
secret), and force a passphrase-encrypted backup export before the user
reaches the wallet home. It also wires up (but does not yet consume) the two
heavy client-side crypto dependencies later tasks need in-browser: `@ctd/sdk`'s
bb.js/UltraHonk prover (Task 11, CT send/receive) and the `stellar-private-payments`
browser SDK (Task 12, SPP deposit/withdraw) — both need special Vite handling
(cross-origin isolation headers, vendored static assets) set up now so those
tasks can just import them.

## Structure

| Path | Purpose |
|---|---|
| `app/vite.config.ts` | COOP/COEP cross-origin-isolation headers (dev + preview); manual `Buffer`/`global` polyfill (`resolve.alias` + `define`, NOT `vite-plugin-node-polyfills` — see Gotchas); excludes `@aztec/bb.js` from bundling. |
| `app/scripts/vendor-bb.mjs` | Copies `@aztec/bb.js`'s `dest/browser/` build to `public/vendor/bb/` (predev/prebuild/prepreview). Gitignored output. |
| `app/scripts/vendor-spp.mjs` | Copies `stellar-private-payments`'s `dist/` tree to `public/spp/`, preserving `workers/`↔`circuits/` siblinghood (predev/prebuild/prepreview). Gitignored output. |
| `app/src/lib/kit.ts` | `SmartAccountKit` singleton, config sourced from `@grantfox/shared`'s `TESTNET`. |
| `app/src/lib/bb-loader.ts` | `ensureBrowserBackend()` — points `@ctd/sdk`'s UltraHonk backend loader at the vendored `/vendor/bb/index.js` (native ESM, not bundled). Not yet exercised by a proving call (Task 11). |
| `app/src/lib/privacy-bundle.ts` (+ `.test.ts`) | `PrivacyBundle` type, `createBundle`/`saveBundle`/`loadBundle`/`clearBundle` (IndexedDB via `idb-keyval`). |
| `app/src/lib/backup.ts` (+ `.test.ts`) | `exportBackup`/`importBackup` — WebCrypto PBKDF2→AES-256-GCM envelope for the privacy bundle. |
| `app/src/providers/WalletProvider.tsx` | `WalletProvider`/`useWallet()` — session restore, `createWallet`, `connectExisting`, `refreshBundle`. |
| `app/src/pages/Landing.tsx` | Entry point: routes to `/wallet` (session restored) or the create/connect choice. |
| `app/src/pages/Onboarding.tsx` | First-time-user flow: passkey-create + fund + mint bundle, then forces `/backup-export`. |
| `app/src/pages/BackupExport.tsx` | Forced backup-export step; "Continue" stays disabled until an export has happened. |
| `app/src/pages/Connect.tsx` | Returning-user passkey connect; routes to `/restore` if the bundle is missing locally. |
| `app/src/pages/RestoreBackup.tsx` | Decrypts an uploaded backup file and persists the recovered bundle. |
| `app/src/pages/Shell.tsx` | Wallet home layout: tab bar (`Wallet` live; `Send`/`Deposit`/`Activity` are Task 11/12/later stubs). |
| `app/src/App.tsx`, `app/src/main.tsx` | Route table; app bootstrap (calls `ensureBrowserBackend()` once, browser-guarded). |
| `app/vitest.config.ts`, `app/vitest.setup.ts` | Unit-test config: plain Node environment + `fake-indexeddb/auto` (jsdom does not implement IndexedDB). |

## Public surface (key exports, verified `file:line`)

- `kit` (`SmartAccountKit` instance) — `app/src/lib/kit.ts:14`
- `PrivacyBundle`, `createBundle(cAddress)`, `saveBundle`, `loadBundle`, `clearBundle` — `app/src/lib/privacy-bundle.ts:16,57,67,71,76`
- `BackupEnvelope`, `BackupDecryptionError`, `exportBackup(bundle, passphrase)`, `importBackup(file, passphrase)` — `app/src/lib/backup.ts:20,30,68,85`
- `ensureBrowserBackend()` — `app/src/lib/bb-loader.ts:29`
- `WalletProvider`, `useWallet()` — `app/src/providers/WalletProvider.tsx:53,166`

## Dependencies

- `smart-account-kit` (`0.4.2`) + `smart-account-kit-bindings` (transitive) — passkey smart-account client. Config fields verified against `resources/smart-account-kit/src/types.ts:107-273`.
- `@ctd/sdk`, `@grantfox/shared` (workspace) — CT key derivation/addr_f guard, TESTNET config.
- `stellar-private-payments` (`0.1.0-alpha.1`) — vendoring source only as of this task; not yet imported by app code (Task 12).
- `@aztec/bb.js` (`0.87.0`, devDependency) — pinned to match `packages/ctd-sdk/package.json`'s own dependency, so the vendored browser build matches what `@ctd/sdk`'s Node loader would otherwise import.
- `idb-keyval` — privacy-bundle persistence. `buffer` — manual Buffer polyfill (see Gotchas).
- `react` `19.2.x`, `react-router` `8.x` (declarative `BrowserRouter`/`Routes`/`Route`, not framework/data-router mode).
- `vite` `^6.4.3`, `@vitejs/plugin-react`, `vitest` + `fake-indexeddb`.

## Gotchas & invariants

- **`vite-plugin-node-polyfills` was tried and rejected.** It's the mechanism named in the original task brief, but v0.28.0's Rollup `onwarn` hook converts *every* unresolved-import warning anywhere in the dependency graph into a hard build failure — reproduced both against `@ctd/sdk`'s own `Buffer` usage (`packages/ctd-sdk/src/chain/{payload,factory}.ts`) and, independently, against `react-router`'s unrelated optional server-runtime `cookie-es` import, under both Vite 8 (Rolldown) and Vite 6 (classic Rollup). Replaced with the manual `resolve.alias` (`buffer` package) + `define: { global: "globalThis" }` pattern from `resources/smart-account-kit/demo/vite.config.ts` — a proven, in-repo config for the same underlying `@stellar/stellar-sdk` Buffer/global requirement. If bringing the polyfill plugin back, re-verify a full `vite build` first.
- **Vite pinned to `^6.4.3`, not latest (8.x).** Same root cause as above surfaced identically under Vite 8's new default Rolldown bundler; pinning to the mature classic-Rollup 6.x line removes one variable while the polyfill-plugin question was being debugged. Not re-tested against 8.x after the switch to manual polyfilling — do that before bumping.
- **COEP must be `credentialless`, not `require-corp`.** `require-corp` would require every cross-origin response (Soroban RPC, the SPP bootnode) to send back CORP headers those endpoints don't send, breaking `fetch()` to them; `credentialless` still yields `crossOriginIsolated === true` for bb.js's wasm threads. Verified in both `pnpm dev` and `pnpm preview` via Playwright (`window.crossOriginIsolated === true`, headers present via `curl -I`).
- **`createBundle(cAddress)` does NOT use `cAddress` to derive `ctKeys`.** CT keys bind to the token contract's `addr_f` (`TESTNET.ct.token`), always — not the caller's wallet address. An earlier draft of this task's brief said otherwise; Task 4's gate corrected it. `cAddress` is validated (`StrKey.isValidContract`) as a guard against passing the wrong kind of address at the call site, not used cryptographically. A runtime guard (`assertAddrFMatchesDeployedToken`, mirroring `scripts/smoke-ct.ts:372-375`) throws if `@ctd/sdk`'s Poseidon2 ever drifts from the deployed token's `addr_f`.
- **`kit.createWallet(..., { autoSubmit: true })` deploys via the relayer first, and silently falls back to direct RPC on relayer rejection.** Empirically observed during browser verification: the relayer proxy returned `400` for the deploy call, and the kit's own internal fallback then completed the deploy over RPC — the create-wallet flow does NOT `forceMethod: "rpc"` the way `resources/smart-account-kit/demo` does (that demo forces RPC specifically to keep deploy off the relayer by design choice, not because relayer-deploy is broken). Not deeply investigated *why* the relayer 400'd; if `createWallet` ever appears to hang or fail outright, check whether a future kit/relayer version tightens this and the fallback stops happening.
- **`WalletProvider.createWallet`'s friendbot-funding step is best-effort/non-fatal.** A `fundAddress` failure is caught and logged, not thrown — the wallet is otherwise fully created and usable via the relayer at 0 XLM; only later fee-paying flows need the funding to have succeeded.
- **jsdom does not implement IndexedDB.** `vitest.config.ts` uses the plain Node environment (not jsdom) with `fake-indexeddb/auto` imported in `vitest.setup.ts`, since Node's native WebCrypto (`backup.ts`) needs no DOM either.
- Vendor script outputs (`app/public/vendor/`, `app/public/spp/`) are build artifacts, gitignored at the repo root; both scripts resolve their source via the guaranteed `app/node_modules/<pkg>` symlink path (pnpm always creates this for a direct dependency) rather than `require.resolve("<pkg>/package.json")`, because neither `@aztec/bb.js` nor `stellar-private-payments` declares a `./package.json` export, which makes Node's strict `exports`-map resolution reject that subpath.
- `smart-account-kit`'s own `@stellar/stellar-sdk` dependency (`16.0.1`) is overridden to the monorepo's pinned `16.2.0` by the root `pnpm.overrides` — do not remove that override (see root `CLAUDE.md`/`package.json`).

## Testing

- `pnpm --filter app test` (`vitest run`) — 13 tests across `src/lib/privacy-bundle.test.ts` (8) and `src/lib/backup.test.ts` (5). Verified passing; both suites were mutation-tested during development (temporarily reintroducing the exact bugs the tests target — deriving `addr_f` from `cAddress` instead of the token, and swallowing the GCM auth failure instead of rethrowing — to confirm the assertions actually catch them, not just pass vacuously).
- `pnpm --filter app run build` (`tsc --noEmit && vite build`, with vendoring via `prebuild`) — verified passing.
- `pnpm --filter app dev` / `pnpm --filter app preview` — both verified via Playwright: `window.crossOriginIsolated === true`, `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers present (`curl -I`).
- Full onboarding flow verified live against testnet via Playwright + a CDP WebAuthn virtual authenticator (`WebAuthn.addVirtualAuthenticator`, `automaticPresenceSimulation: true`): passkey creation → wallet deploy (contract `CCTQ25OEEOQC6K7BY3GUZSC2CAUFGHBKCMY5V5TTAQ7KZFO5ABEH6JLT`, confirmed on `api.stellar.expert` with `wasm` matching `TESTNET.smartAccount.accountWasmHash` exactly) → friendbot funding (`200` from `friendbot.stellar.org`) → bundle creation → forced backup export (real file download, `{v,salt,iv,ct}` envelope) → wallet home. Also verified: session survives reload (silent restore, no re-prompt); returning-user connect correctly detects a missing local bundle and routes to `/restore`; restore rejects the wrong passphrase in the UI (`BackupDecryptionError` message shown) and accepts the correct one, recovering the exact original bundle (`createdAt` byte-identical) via the real downloaded backup file.
