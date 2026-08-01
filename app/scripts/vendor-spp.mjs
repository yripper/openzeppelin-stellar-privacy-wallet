/**
 * Vendor stellar-private-payments' `dist/` tree into public/spp/.
 *
 * Why: the SPP browser SDK's wasm module and its two Web Workers
 * (prover-worker*, storage-worker*) resolve each other as siblings on disk
 * (`dist/workers/` next to `dist/circuits/` next to
 * `dist/stellar_private_payments_sdk_web.js`) — copying the whole `dist/`
 * directory verbatim preserves that siblinghood. Task 12 (the SPP deposit/
 * withdraw flow) is what actually imports these from `/spp/`; this task only
 * wires up the vendoring so the files are present at a stable public path.
 *
 * Idempotent: safe to re-run (predev/prebuild/prepreview) — overwrites the
 * destination each time via `fs.cp({ force: true })`.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// `stellar-private-payments` is a direct dependency of app/package.json, so
// pnpm always creates a real symlink at app/node_modules/stellar-private-payments
// regardless of its `exports` map (which doesn't declare `./package.json`, so
// `require.resolve("stellar-private-payments/package.json")` fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED — hence the plain filesystem path instead).
const srcDir = resolve(here, "..", "node_modules", "stellar-private-payments", "dist");
if (!existsSync(srcDir)) {
  throw new Error(
    `could not find stellar-private-payments dist/ at ${srcDir} — run "pnpm install" in app/ first`
  );
}
const destDir = resolve(here, "..", "public", "spp");

await mkdir(destDir, { recursive: true });
await cp(srcDir, destDir, { recursive: true, force: true });

const files = await readdir(destDir);
console.log("vendored stellar-private-payments dist/");
console.log(`  from ${srcDir}`);
console.log(`  to   ${destDir}`);
console.log(`  entries: ${files.join(", ")}`);
