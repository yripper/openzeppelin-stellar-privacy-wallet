# app Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `app/` · **Last verified:** 2026-08-01 (Task 11)

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

**Task 11 — the Confidential Token (CT) rail.** Adds the wallet's actual
CT send/receive experience on top of Task 10's scaffold: `lib/ct.ts` (a thin
`CtRail` orchestrator over `@ctd/sdk` — witness build → prove → encode →
`buildCtInvokeTx` → `kit.signAndSubmit` → `StateEngine.sync()`, mirroring
`scripts/smoke-ct.ts`'s gate-proven sequencing but with the kit handling
WebAuthn auth-entry signing instead of a hand-signed `AuthPayload`),
`lib/ct-indexer.ts` (an `IndexerClient` subclass that decodes `@grantfox/api`'s
base64-XDR event rows — REQUIRED per `docs/modules/api.md`'s "Consuming CT
events from this API", since the stock `IndexerClient` silently decodes zero
events against our API), `providers/CtProvider.tsx` (one shared `CtRail`
instance per session, mirroring `kit.ts`/`WalletProvider.tsx`'s split),
`components/{BalanceCard,SendForm,ActivityFeed}.tsx`, and `pages/Confidential.tsx`
(composes the three, rendered inside `Shell`'s "Wallet" tab). Also required
three previously-latent fixes surfaced only once a real proving call ran
in-browser for the first time (bb-loader.ts was vendored in Task 10 but
never exercised): two additional `optimizeDeps.exclude` entries for
`@noir-lang/{noir_js,acvm_js,noirc_abi}` (same `import.meta.url`-relative-wasm
problem as bb.js itself) and a small dev-only Vite middleware
(`serveVendorRaw` in `vite.config.ts`) working around a Vite dev-server guard
against dynamically `import()`-ing a `/public` file from source — see
Gotchas for both. Also added CORS to `@grantfox/api` (`docs/modules/api.md`'s
"Task 11 — CORS" entry) — a prerequisite this task needed, not an app-side
file.

## Structure

| Path | Purpose |
|---|---|
| `app/vite.config.ts` | COOP/COEP cross-origin-isolation headers (dev + preview); manual `Buffer`/`global` polyfill (`resolve.alias` + `define`, NOT `vite-plugin-node-polyfills` — see Gotchas); excludes `@aztec/bb.js` + the `@noir-lang/*` wasm packages (Task 11) from bundling; `serveVendorRaw` dev-only middleware (Task 11, see Gotchas) serving `/vendor/**` raw with COOP/COEP headers attached manually. |
| `app/scripts/vendor-bb.mjs` | Copies `@aztec/bb.js`'s `dest/browser/` build to `public/vendor/bb/` (predev/prebuild/prepreview). Gitignored output. |
| `app/scripts/vendor-spp.mjs` | Copies `stellar-private-payments`'s `dist/` tree to `public/spp/`, preserving `workers/`↔`circuits/` siblinghood (predev/prebuild/prepreview). Gitignored output. |
| `app/src/lib/kit.ts` | `SmartAccountKit` singleton, config sourced from `@grantfox/shared`'s `TESTNET`. |
| `app/src/lib/bb-loader.ts` | `ensureBrowserBackend()` — points `@ctd/sdk`'s UltraHonk backend loader at the vendored `/vendor/bb/index.js` (native ESM, not bundled). Exercised live by Task 11's proving calls (register/transfer/withdraw). |
| `app/src/lib/privacy-bundle.ts` (+ `.test.ts`) | `PrivacyBundle` type, `createBundle`/`saveBundle`/`loadBundle`/`clearBundle` (IndexedDB via `idb-keyval`). |
| `app/src/lib/backup.ts` (+ `.test.ts`) | `exportBackup`/`importBackup` — WebCrypto PBKDF2→AES-256-GCM envelope for the privacy bundle. |
| `app/src/lib/format.ts` (+ `.test.ts`, Task 11) | `stroopsToXlm`/`xlmToStroops` (bigint-only, no float math on stroops — 1 XLM = 10_000_000 stroops) + `truncateAddress`/`truncateHash` display helpers. |
| `app/src/lib/ct-indexer.ts` (+ `.test.ts`, Task 11) | `ApiIndexerClient` — an `IndexerClient` (`@ctd/sdk`) SUBCLASS overriding `fetchEvents`/`resolveEventRef` to decode `@grantfox/api`'s base64-XDR event rows through `buildConfidentialEvent` (the same field-mapping single source of truth the RPC decoder uses), instead of the inherited Goldsky-JSON decoder — required per `docs/modules/api.md`'s "Consuming CT events from this API" (pointing the stock `IndexerClient` at our API silently decodes zero events). Subclasses (not duck-types) `IndexerClient` so it satisfies `hybridFetchEvents`/`hybridResolveEventRef`'s `IndexerClient \| undefined` parameter type exactly. Also exports `parseApiEvent` (the row decoder) for direct unit testing. |
| `app/src/lib/ct.ts` (Task 11) | `CtRail` — the CT orchestrator: `register()`/`deposit(amount)`/`merge()`/`transfer(to, amount)`/`withdraw(amount)`, each witness (→ prove where required) → encode → `buildCtInvokeTx` (`source: kit.deployerPublicKey`, the same account `kit.signAndSubmit`'s internal re-simulation always re-sources from) → `kit.signAndSubmit` → (transfer/withdraw only) an optimistic local `StateEngine.setSpendable`. `refresh()` — `StateEngine.sync()` + `verifyAgainstChain()` + public SAC `balance()` simulation, returned as one `CtView` snapshot. `decryptTransferAmount(event)` — inbound via `StateEngine.decryptIncoming`, outbound via the deterministic-`r_e` re-derivation + ECDH pattern (`resources/stellar-confidential-token-demo/packages/app/lib/wallet.ts:327-368`). `resolveActivityEvent(row)` — resolves a `ct_activity` feed row's full on-chain event via `ct-indexer.ts`'s adapter, the bridge `ActivityFeed.tsx` uses to decrypt a `transfer` row's `null` amount. Exports `API_URL` (`VITE_API_URL`, default `http://localhost:3000`). |
| `app/src/providers/CtProvider.tsx` (Task 11) | `CtProvider`/`useCt()` — one shared `CtRail` per (contractId, bundle) session (mirrors the `kit.ts`/`WalletProvider.tsx` split), exposing `{rail, view, loading, error, refresh}`; tears the rail down (freeing bb.js provers) on session change/unmount. |
| `app/src/components/BalanceCard.tsx` (Task 11) | Public XLM + spendable/receiving + on-chain-verification status; register/deposit/merge/withdraw quick actions (`ct.ts`'s five methods minus `transfer`). |
| `app/src/components/SendForm.tsx` (Task 11) | Recipient address + a live "is this address registered for confidential transfers?" check on blur/paste (`rail.isRegistered`, CT contract read via simulation) — shows "ask them to activate privacy first" copy when unregistered; amount; submits via `rail.transfer`. |
| `app/src/components/ActivityFeed.tsx` (Task 11) | `GET /accounts/:address/activity` (`@grantfox/api`'s own feed) newest-first; `deposit`/`withdraw` amounts are public (already on the row); `transfer` amounts are `null` on the row and decrypted client-side per-row (`rail.resolveActivityEvent` + `rail.decryptTransferAmount`), showing a `+`/`-` sign by resolved direction. |
| `app/src/pages/Confidential.tsx` (Task 11) | Composes `CtProvider` + `BalanceCard`/`SendForm`/`ActivityFeed`; rendered inside `Shell`'s "Wallet" tab (`Shell.tsx` updated Task 11 — tab bar reduced to `Wallet`/`Deposit`, since CT's send + activity now live inside the Wallet tab's Confidential dashboard rather than as separate placeholder tabs; `Deposit` remains a Task-12 SPP stub). |
| `app/src/providers/WalletProvider.tsx` | `WalletProvider`/`useWallet()` — session restore, `createWallet`, `connectExisting`, `refreshBundle`. |
| `app/src/pages/Landing.tsx` | Entry point: routes to `/wallet` (session restored) or the create/connect choice. |
| `app/src/pages/Onboarding.tsx` | First-time-user flow: passkey-create + fund + mint bundle, then forces `/backup-export`. |
| `app/src/pages/BackupExport.tsx` | Forced backup-export step; "Continue" stays disabled until an export has happened. |
| `app/src/pages/Connect.tsx` | Returning-user passkey connect; routes to `/restore` if the bundle is missing locally. |
| `app/src/pages/RestoreBackup.tsx` | Decrypts an uploaded backup file and persists the recovered bundle. |
| `app/src/pages/Shell.tsx` | Wallet home layout: tab bar (`Wallet` — details + the Task 11 Confidential dashboard; `Deposit` — Task 12 SPP stub). |
| `app/src/App.tsx`, `app/src/main.tsx` | Route table; app bootstrap (calls `ensureBrowserBackend()` once, browser-guarded). |
| `app/vitest.config.ts`, `app/vitest.setup.ts` | Unit-test config: plain Node environment + `fake-indexeddb/auto` (jsdom does not implement IndexedDB). |

## Public surface (key exports, verified `file:line`)

- `kit` (`SmartAccountKit` instance) — `app/src/lib/kit.ts:14`
- `PrivacyBundle`, `createBundle(cAddress)`, `saveBundle`, `loadBundle`, `clearBundle` — `app/src/lib/privacy-bundle.ts:16,57,67,71,76`
- `BackupEnvelope`, `BackupDecryptionError`, `exportBackup(bundle, passphrase)`, `importBackup(file, passphrase)` — `app/src/lib/backup.ts:20,30,68,85`
- `ensureBrowserBackend()` — `app/src/lib/bb-loader.ts:29`
- `WalletProvider`, `useWallet()` — `app/src/providers/WalletProvider.tsx:53,166`
- `stroopsToXlm`, `xlmToStroops`, `truncateAddress`, `truncateHash` (Task 11) — `app/src/lib/format.ts`
- `ApiIndexerClient`, `parseApiEvent` (Task 11) — `app/src/lib/ct-indexer.ts`
- `CtRail` (`.connect`, `.register`/`.deposit`/`.merge`/`.transfer`/`.withdraw`/`.refresh`/`.isRegistered`/`.publicBalance`/`.decryptTransferAmount`/`.resolveActivityEvent`/`.destroy`), `CtView`, `API_URL` (Task 11) — `app/src/lib/ct.ts`
- `CtProvider`, `useCt()` (Task 11) — `app/src/providers/CtProvider.tsx`
- `BalanceCard`, `SendForm`, `ActivityFeed` (default exports, Task 11) — `app/src/components/{BalanceCard,SendForm,ActivityFeed}.tsx`
- `Confidential` (default export, Task 11) — `app/src/pages/Confidential.tsx`

## Dependencies

- `smart-account-kit` (`0.4.2`) + `smart-account-kit-bindings` (transitive) — passkey smart-account client. Config fields verified against `resources/smart-account-kit/src/types.ts:107-273`. Task 11 also uses the kit's `deployerPublicKey` getter (`buildCtInvokeTx`'s fee-payer source — the same deterministic G-address `kit.signAndSubmit`'s internal re-simulation always re-sources from) and `signAndSubmit` itself.
- `@ctd/sdk`, `@grantfox/shared` (workspace) — CT key derivation/addr_f guard, TESTNET config. Task 11 additionally imports the witness builders, `StateEngine`/`LocalStorageStore`, `IndexerClient` (subclassed), the payload encoders, and the crypto primitives (`ecdh`/`scalarMul`/`H`/`deriveEphemeralRE`/`decryptWithDomain`/`DOMAIN`) needed for `decryptTransferAmount`'s sender-side re-derivation.
- `stellar-private-payments` (`0.1.0-alpha.1`) — vendoring source only as of this task; not yet imported by app code (Task 12).
- `@aztec/bb.js` (`0.87.0`, devDependency) — pinned to match `packages/ctd-sdk/package.json`'s own dependency, so the vendored browser build matches what `@ctd/sdk`'s Node loader would otherwise import.
- `@noir-lang/noir_js` (transitive, via `@ctd/sdk`) — `CircuitProver`'s witness solver; imports `@ctd/sdk/circuits/{register,transfer,withdraw}.json` directly (Vite's native JSON import, via the `@ctd/sdk` package's `./circuits/*` subpath export) rather than the Node-only `loadCircuit()`.
- `idb-keyval` — privacy-bundle persistence. `buffer` — manual Buffer polyfill (see Gotchas).
- `react` `19.2.x`, `react-router` `8.x` (declarative `BrowserRouter`/`Routes`/`Route`, not framework/data-router mode).
- `vite` `^6.4.3`, `@vitejs/plugin-react`, `vitest` + `fake-indexeddb`.
- `@grantfox/api` (Task 11, network dependency not a package dependency) — `ct-indexer.ts`/`ActivityFeed.tsx` call it directly over HTTP (`VITE_API_URL`, default `http://localhost:3000`); requires the CORS fix documented in `docs/modules/api.md`'s "Task 11 — CORS" entry.

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
- **(Task 11) `@noir-lang/acvm_js`/`@noir-lang/noirc_abi` need the SAME `optimizeDeps.exclude` treatment as `@aztec/bb.js`, for the same reason.** Both are wasm-bindgen web-target builds doing `new URL('*_bg.wasm', import.meta.url)` (the standard pattern) to locate their own `.wasm` file. Left un-excluded, esbuild's dev-time dependency pre-bundling moves the compiled JS into `.vite/deps/`, so `import.meta.url` no longer sits next to the real `.wasm` — the fetch resolves to a path that doesn't exist, Vite's dev-server SPA fallback (`appType: "spa"`'s default catch-all) returns `index.html` for it (200, `text/html`), and `WebAssembly.instantiate()` throws `"expected magic word 00 61 73 6d, found 3c 21 64 6f"` (`<!do`, i.e. it tried to instantiate the HTML page as wasm). Reproduced live via Playwright on `CircuitProver.prove()`'s first `noir.execute()` call (witness solving). Fixed by adding `@noir-lang/noir_js`/`@noir-lang/acvm_js`/`@noir-lang/noirc_abi` to `optimizeDeps.exclude` (`noir_js` itself included too, so its module graph isn't half-optimized) — Vite then serves all three straight from `node_modules`, where `import.meta.url` resolves correctly.
- **(Task 11) Vite's DEV server (not `vite build`/`vite preview`) refuses to serve a `/public`-mapped `.js` file dynamically `import()`ed from source, even with `/* @vite-ignore */`.** `bb-loader.ts`'s `import(/* @vite-ignore */ "/vendor/bb/index.js")` — the documented pattern for loading the vendored bb.js as native ESM (needed so its own `new Worker(new URL('./main.worker.js', import.meta.url))` resolves against a real directory) — failed under `pnpm dev` only: `Failed to fetch dynamically imported module: .../vendor/bb/index.js?import`, with Vite's error overlay explaining "This file is in /public and will be copied as-is during build without going through the plugin transforms, and therefore should not be imported from source code. It can only be referenced via HTML tags." `@vite-ignore` only silences Vite's dynamic-import *analysis* warning — it does not suppress this separate dev-server-side publicDir guard. Reproduced live via Playwright (register's first proving attempt). **Fixed** with a small `configureServer` middleware (`serveVendorRaw` in `vite.config.ts`) that intercepts every `/vendor/**` request and serves it straight off disk, registered BEFORE Vite's own middlewares (call `server.middlewares.use` directly in the hook body, not inside a returned post-hook function) so the guard never triggers regardless of how the request arrived. **Verified NOT needed for `vite build`/`vite preview`** — production `/public` files are served as plain static files with no transform pipeline in front of them at all, confirmed live (`curl -I` on the built `/vendor/bb/index.js` and `main.worker.js`, correct `Content-Type`/COOP/COEP, no guard).
- **(Task 11) Bypassing Vite's pipeline (the previous entry's fix) also skips its `server.headers` middleware — `serveVendorRaw` MUST set the COOP/COEP headers itself.** Missing them broke a DIFFERENT, much harder to diagnose way: `main.worker.js`/`thread.worker.js` fetched fine as plain files (200, correct content), but the PAGE's own `new Worker(...)` construction (bb.js spawning its proving threads) then failed with `net::ERR_BLOCKED_BY_RESPONSE` — Chromium requires a COEP document's dedicated-worker SCRIPT RESPONSE to itself carry a compatible COEP header, not just the document that constructs the worker. The failure mode is silent on the page side (no console error, no rejected promise — `CircuitProver.prove()`'s `await backend.generateProof(...)` just hangs forever): the only signal is the network log showing the worker request as `requestfailed`, and `page.workers().length === 0` staying zero indefinitely. Diagnosed by attaching Playwright's `worker`/`requestfailed` event listeners around a `register()` call; fixed by having `serveVendorRaw` attach the same `crossOriginIsolationHeaders` constant the rest of the server config uses.

## Testing

- `pnpm --filter app test` (`vitest run`) — 13 tests across `src/lib/privacy-bundle.test.ts` (8) and `src/lib/backup.test.ts` (5). Verified passing; both suites were mutation-tested during development (temporarily reintroducing the exact bugs the tests target — deriving `addr_f` from `cAddress` instead of the token, and swallowing the GCM auth failure instead of rethrowing — to confirm the assertions actually catch them, not just pass vacuously).
- `pnpm --filter app run build` (`tsc --noEmit && vite build`, with vendoring via `prebuild`) — verified passing.
- `pnpm --filter app dev` / `pnpm --filter app preview` — both verified via Playwright: `window.crossOriginIsolated === true`, `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers present (`curl -I`).
- Full onboarding flow verified live against testnet via Playwright + a CDP WebAuthn virtual authenticator (`WebAuthn.addVirtualAuthenticator`, `automaticPresenceSimulation: true`): passkey creation → wallet deploy (contract `CCTQ25OEEOQC6K7BY3GUZSC2CAUFGHBKCMY5V5TTAQ7KZFO5ABEH6JLT`, confirmed on `api.stellar.expert` with `wasm` matching `TESTNET.smartAccount.accountWasmHash` exactly) → friendbot funding (`200` from `friendbot.stellar.org`) → bundle creation → forced backup export (real file download, `{v,salt,iv,ct}` envelope) → wallet home. Also verified: session survives reload (silent restore, no re-prompt); returning-user connect correctly detects a missing local bundle and routes to `/restore`; restore rejects the wrong passphrase in the UI (`BackupDecryptionError` message shown) and accepts the correct one, recovering the exact original bundle (`createdAt` byte-identical) via the real downloaded backup file.
- **Task 11 (2026-08-01)**: `pnpm --filter app test` (`vitest run`) — 40 tests (13 prior + 10 new `ct-indexer.test.ts` [real, live-captured `@grantfox/api` response rows as fixtures — see the file's own module doc for the exact capture transcript; one case cross-checks the adapter's decoded transfer-event fields byte-for-byte against `normalize-ct.ts`'s independently-decoded hex `ciphertexts` for the SAME on-chain event] + 17 new `format.test.ts`). `pnpm --filter app run typecheck` and `pnpm --filter app run build` (from a clean `rm -rf dist public/vendor public/spp`) — both clean.
  - **Full CT lifecycle verified live against testnet, in-browser, via Playwright** (two separate browser contexts, each its own CDP WebAuthn virtual authenticator — two independent wallets, "Alice" and "Bob"; `@grantfox/api` server + worker running locally against docker Postgres, `VITE_API_URL` pointed at it):
    - **Register** (both wallets): real in-browser UltraHonk proof (bb.js, multithreaded via the vendored `/vendor/bb/`) → `kit.signAndSubmit` (WebAuthn, auto-approved by the virtual authenticator) → on-chain submit → `Status: "Activated · verified against chain"` (i.e. `StateEngine.verifyAgainstChain().ok === true`, not just "the transaction succeeded").
    - **Deposit** (Alice, 100 XLM): Public XLM `10000 → 9900`, Receiving `0 → 100` — arithmetically consistent, no proof (deposit needs none).
    - **Merge** (Alice): Spendable `0 → 100`, Receiving `100 → 0`.
    - **Transfer** (Alice → Bob, 40 XLM): real in-browser proof + submit; Alice's spendable `100 → 60` (optimistic `setSpendable`, confirmed by the subsequent `refresh()`'s real `engine.sync()` + `verifyAgainstChain()`); SendForm's recipient-registered check showed "Ready to receive confidential transfers." before sending (the CT contract simulate-read, `rail.isRegistered`).
    - **Bob receives**: after a page reload (fresh `StateEngine.sync()` from RPC events), Bob's Receiving shows `40 XLM`, `ECDH-decrypted from the event` via `StateEngine.decryptIncoming`, status "verified against chain".
    - **Merge** (Bob): Spendable `0 → 40`.
    - **Withdraw** (Alice, 60 XLM): real in-browser proof + submit; Public XLM `9900 → 9960`, Spendable `60 → 0` — `9900 + 60 = 9960`, consistent.
    - **Activity feed, both wallets, reading `@grantfox/api`'s `GET /accounts/:address/activity` (NOT RPC)**: Alice's feed shows `Transfer · CDZQWN…6MVFTY · -40 XLM` (outbound, sender-side ephemeral-scalar re-derivation + ECDH against Bob's on-chain PVK — `row.amount` is `null` on this row; the sign and value are recovered entirely client-side via `resolveActivityEvent` + `decryptTransferAmount`); Bob's feed shows the SAME event as `Transfer · CAJCF4…5IQH4G · +40 XLM` (inbound, `StateEngine.decryptIncoming` with Bob's own viewing key) — two independently-keyed decryptions of the same on-chain ciphertext agreeing exactly is the load-bearing proof that both the adapter and the decrypt logic are correct, not just that the numbers happen to match. `Deposit`/`Withdraw`/`Register`/`Merge` rows render correctly too (public amounts, or "Private" for the two with none).
  - **Required fixes discovered by this run** (all documented above in Gotchas, not just a note here): `optimizeDeps.exclude` for the `@noir-lang/*` wasm packages; the `serveVendorRaw` dev-only Vite middleware (publicDir-dynamic-import guard); that middleware setting COOP/COEP headers itself; and CORS on `@grantfox/api` (`docs/modules/api.md`'s "Task 11 — CORS"). None of these were exercisable before this task — Task 10 scaffolded the dependencies but never actually proved in-browser, and no prior task's browser code ever called this repo's own REST API cross-origin.
  - No key material (`sk`, `vk`, seeds, raw private key bytes) appears in any console output or log across the whole run — verified both by code review (`grep` for `console.*` across every Task 11 file: none) and by inspecting the captured Playwright console/network logs.
  - Full transcript (every command, every intermediate balance, exact contract addresses and tx hashes): task-11 report (`.superpowers/sdd/2026-07-31-privacy-wallet/task-11-report.md`, gitignored).
