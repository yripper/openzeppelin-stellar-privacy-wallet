import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite's DEV server (not `vite build`/`vite preview` — those just copy
 * `/public` as plain static files, per Vite's own docs) refuses to serve a
 * `/public`-mapped `.js` file through its import-analysis/transform
 * middleware when it's reached via a dynamic `import()` from source code
 * Vite is tracking (`bb-loader.ts`'s `import(/* @vite-ignore *\/ BB_URL)`,
 * the documented pattern for loading the vendored bb.js as native ESM):
 * `Failed to fetch dynamically imported module: .../vendor/bb/index.js?import`,
 * with Vite's error overlay explaining "This file is in /public and will be
 * copied as-is during build without going through the plugin transforms,
 * and therefore should not be imported from source code. It can only be
 * referenced via HTML tags." `@vite-ignore` does not suppress this — it
 * only silences Vite's dynamic-import analysis warning, not this separate
 * dev-server-side publicDir guard. Reproduced live via Playwright while
 * proving `register` in-browser for the first time (bb-loader.ts was
 * vendored in Task 10 but never actually exercised by a proving call until
 * this task).
 *
 * Fix: intercept `/vendor/**` requests with a plugin `configureServer`
 * middleware registered BEFORE Vite installs its own (the standard "run
 * early" pattern: call `server.middlewares.use` directly in the hook body,
 * not inside a returned post-hook function), and serve the file straight
 * off disk — bypassing Vite's transform pipeline entirely, so the guard
 * never triggers regardless of how the request arrived (`?import` suffix or
 * not). Only affects `pnpm dev`; `vite build`/`preview` were unaffected
 * (verified) and need no such workaround.
 *
 * Bypassing Vite's pipeline also skips its `server.headers` middleware
 * (below), which is where the COOP/COEP headers normally get attached to
 * EVERY response — so this middleware must set them itself too. Missing
 * them here broke a DIFFERENT way than the guard above: `main.worker.js`/
 * `thread.worker.js` loaded fine as plain files, but the page's own
 * `new Worker(...)` construction (bb.js spawning its proving threads) then
 * failed with `net::ERR_BLOCKED_BY_RESPONSE` — Chromium requires a COEP
 * document's dedicated-worker SCRIPT RESPONSE to itself carry a compatible
 * COEP header, not just the document that constructs it. Reproduced live:
 * without this, `register`'s proof call hung forever with zero workers ever
 * spawned (`page.workers().length === 0`), no console output, no thrown
 * rejection — silent, since nothing on the page-side ever learns the worker
 * failed to load; only the network log showed the blocked request.
 */
function serveVendorRaw(): Plugin {
  return {
    name: "serve-vendor-raw",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/vendor/")) return next();
        const relative = url.split("?")[0]!.replace(/^\/vendor\//, "");
        const filePath = fileURLToPath(new URL(`./public/vendor/${relative}`, import.meta.url));
        if (!existsSync(filePath)) return next();
        for (const [key, value] of Object.entries(crossOriginIsolationHeaders)) {
          res.setHeader(key, value);
        }
        if (filePath.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        else if (filePath.endsWith(".js")) res.setHeader("Content-Type", "text/javascript");
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

/**
 * The privacy wallet proves Confidential Token operations in-browser via
 * bb.js (UltraHonk), which needs multithreading -> SharedArrayBuffer ->
 * cross-origin isolation (`crossOriginIsolated === true`).
 *
 * COEP `credentialless` (not `require-corp`) is required, not just allowed:
 * - SPP's own worker/wasm bundle deliberately avoids SharedArrayBuffer, so it
 *   doesn't need `require-corp`'s stricter guarantees.
 * - `require-corp` would force every cross-origin fetch (the Soroban RPC,
 *   the SPP bootnode) to send back CORP headers we don't control; those
 *   endpoints don't send them, so `require-corp` breaks RPC calls entirely.
 * - `credentialless` still flips on cross-origin isolation for bb.js's wasm
 *   threads without that requirement.
 *
 * Pattern verified against resources/stellar-confidential-token-demo/packages/app/next.config.mjs:5-13
 * (Next equivalent of this same header pair).
 */
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [react(), serveVendorRaw()],
  define: {
    // @stellar/stellar-sdk expects a Node-style `global` in the browser.
    global: "globalThis",
  },
  resolve: {
    alias: {
      // @stellar/stellar-sdk and @ctd/sdk call the global `Buffer` (e.g.
      // `Buffer.from(...)` in packages/ctd-sdk/src/chain/{payload,factory}.ts)
      // without importing it, which only exists natively in Node. Pattern
      // (manual alias + `define: { global }`, not vite-plugin-node-polyfills)
      // verified against resources/smart-account-kit/demo/vite.config.ts,
      // which pins the same `vite: "^8.0.5"` line and the same underlying
      // @stellar/stellar-sdk dependency — vite-plugin-node-polyfills@0.28.0
      // was tried first and rejected: its Rollup `onwarn` hook turns EVERY
      // unresolved-import warning into a hard build failure anywhere in the
      // dependency graph (confirmed against both this app's own build and
      // react-router's unrelated optional server-runtime import), not just
      // ones related to the Buffer shim it injects.
      buffer: fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)),
    },
    // Ensure a pnpm workspace package (e.g. @ctd/sdk, resolved through a
    // node_modules symlink) is treated as the single instance it is, not
    // duplicated via its real on-disk path.
    preserveSymlinks: false,
    dedupe: ["@stellar/stellar-sdk"],
  },
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  optimizeDeps: {
    include: ["buffer", "@stellar/stellar-sdk", "@stellar/stellar-sdk/rpc"],
    // bb.js is never bundled: it's vendored to /public/vendor/bb and loaded
    // as native ESM at runtime (see src/lib/bb-loader.ts + scripts/vendor-bb.mjs)
    // because its wasm Web Worker resolves relative to `import.meta.url`,
    // which breaks once a bundler moves it into a hashed chunk.
    //
    // @noir-lang/acvm_js and @noir-lang/noirc_abi (transitive deps of
    // @noir-lang/noir_js, used by @ctd/sdk's CircuitProver to solve the
    // witness before proving) have the SAME problem for their own wasm:
    // both do `new URL('*_bg.wasm', import.meta.url)` (the standard
    // wasm-bindgen web-target pattern). Left un-excluded, esbuild's dep
    // pre-bundling moves them into `.vite/deps/`, so that `import.meta.url`
    // no longer sits next to the real `.wasm` file — the fetch 404s, Vite's
    // dev server SPA-fallback returns `index.html` for it (200,
    // `text/html`), and `WebAssembly.instantiate()` throws "expected magic
    // word 00 61 73 6d, found 3c 21 64 6f" (`<!do`, i.e. it tried to
    // instantiate the HTML fallback page as wasm). Reproduced live via
    // Playwright while proving `register` in-browser; excluding all three
    // (noir_js itself too, so its own module graph isn't half-optimized)
    // fixes it — Vite then serves them straight from node_modules, where
    // `import.meta.url` correctly resolves next to the real `.wasm` files.
    exclude: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"],
    esbuildOptions: {
      define: { global: "globalThis" },
    },
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /smart-account-kit/, /smart-account-kit-bindings/],
      transformMixedEsModules: true,
    },
  },
});
