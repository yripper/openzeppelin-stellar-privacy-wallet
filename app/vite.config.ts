import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  plugins: [react()],
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
    exclude: ["@aztec/bb.js"],
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
