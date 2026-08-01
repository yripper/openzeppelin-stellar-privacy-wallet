/**
 * Browser bb.js loader.
 *
 * bb.js's `dest/browser/` is copied verbatim into `public/vendor/bb/` by
 * `scripts/vendor-bb.mjs` (run via the app's predev/prebuild). We load it as
 * a NATIVE ES module from that stable path instead of letting Vite bundle
 * it, because bb.js resolves its wasm Web Worker relative to
 * `import.meta.url` (`new Worker(new URL('./main.worker.js', import.meta.url))`).
 * Bundling moves `index.js` into a hashed chunk whose sibling
 * `main.worker.js` doesn't exist there, so the worker never loads and
 * proving hangs. Served from `/vendor/bb/index.js`, `import.meta.url` points
 * at a real directory where the worker + wasm files are present.
 *
 * Pattern verified against
 * resources/stellar-confidential-token-demo/packages/app/lib/bb-loader.ts:32-44
 * (this app is Vite, not Next/webpack, but the same worker-resolution
 * problem and fix apply).
 *
 * `nativeImport` uses `/* @vite-ignore *\/` so Vite never sees a static
 * `import()` to analyze/rewrite into a bundled chunk.
 */
import { setUltraHonkBackendLoader } from "@ctd/sdk";

const BB_URL = "/vendor/bb/index.js";

let registered = false;

/** Point the SDK's prover at the native-ESM bb.js. Idempotent; browser-only. */
export function ensureBrowserBackend(): void {
  if (registered || typeof window === "undefined") return;
  registered = true;
  setUltraHonkBackendLoader(async () => {
    const mod = (await import(/* @vite-ignore */ BB_URL)) as Record<string, unknown>;
    return mod.UltraHonkBackend as never;
  });
}
