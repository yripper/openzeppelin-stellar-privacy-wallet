/**
 * Vendor @aztec/bb.js's browser build into public/vendor/bb/.
 *
 * Why: bb.js spawns its wasm Web Worker with
 *   new Worker(new URL('./main.worker.js', import.meta.url), { type: 'module' })
 * so a bundler that moves bb.js into a hashed chunk breaks that
 * import.meta.url-relative resolution and proving hangs forever. Serving the
 * intact `dest/browser/` directory at a stable public path lets the browser
 * load it as native ESM (see src/lib/bb-loader.ts), bypassing Vite entirely.
 *
 * Pattern verified against
 * resources/stellar-confidential-token-demo/scripts/vendor-bb.mjs (same
 * problem, solved the same way, for the Next.js/webpack build of this same
 * dependency).
 *
 * Idempotent: safe to re-run (predev/prebuild/prepreview) — overwrites the
 * destination each time via `fs.cp({ force: true })`.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// `@aztec/bb.js` is a direct devDependency of app/package.json, so pnpm
// always creates a real symlink at app/node_modules/@aztec/bb.js regardless
// of its `exports` map (which doesn't declare `./package.json`, so
// `require.resolve("@aztec/bb.js/package.json")` fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED — hence the plain filesystem path instead).
const srcDir = resolve(here, "..", "node_modules", "@aztec", "bb.js", "dest", "browser");
if (!existsSync(srcDir)) {
  throw new Error(
    `could not find @aztec/bb.js browser build at ${srcDir} — run "pnpm install" in app/ first`
  );
}
const destDir = resolve(here, "..", "public", "vendor", "bb");

await mkdir(destDir, { recursive: true });
await cp(srcDir, destDir, { recursive: true, force: true });

const files = await readdir(destDir);
console.log("vendored @aztec/bb.js browser build");
console.log(`  from ${srcDir}`);
console.log(`  to   ${destDir}`);
console.log(`  files: ${files.join(", ")}`);
