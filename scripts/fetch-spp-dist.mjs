/**
 * Restore `vendor/stellar-private-payments/sdk/web/dist/` when it is absent —
 * i.e. inside a Railway build.
 *
 * Why this exists: the app installs our forked SPP SDK as a `file:` dependency
 * on `vendor/stellar-private-payments/sdk/web`, whose `dist/` (wasm bundle +
 * circuit artifacts, ~70 MB across 41 files) is committed to git — but
 * `railway up`'s code upload has a hard size cap that 70 MB of
 * incompressible zkeys blows straight through (uploads 500). So the deploy
 * upload excludes `dist/` (`.railwayignore`) and this script re-downloads it
 * file-by-file from the public GitHub repo BEFORE `pnpm install` packs the
 * `file:` dependency (see `railway/app.json`'s buildCommand ordering).
 *
 * Locally it is a no-op: the git checkout already has `dist/`.
 *
 * Ref resolution: `RAILWAY_GIT_COMMIT_SHA` when Railway provides one, else
 * `main` — which is correct for our deploy flow (push to GitHub, then
 * `railway up`), and why pushing BEFORE deploying matters.
 */
import { mkdir, writeFile, stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "yripper/openzeppelin-stellar-privacy-wallet";
const DIST_PREFIX = "vendor/stellar-private-payments/sdk/web/dist/";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(ROOT, DIST_PREFIX);
const REF = process.env.RAILWAY_GIT_COMMIT_SHA || "main";
const CONCURRENCY = 8;

async function distPresent() {
  try {
    await stat(join(DIST_DIR, "stellar_private_payments_sdk_web_bg.wasm"));
    return (await readdir(DIST_DIR)).length > 0;
  } catch {
    return false;
  }
}

async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

if (await distPresent()) {
  console.log(`spp dist already present at ${DIST_PREFIX} — nothing to fetch`);
  process.exit(0);
}

console.log(`spp dist missing — fetching from ${REPO}@${REF}`);
const tree = await (
  await fetchOk(`https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "privacy-wallet-build" },
  })
).json();
if (tree.truncated) throw new Error("GitHub tree listing was truncated — cannot trust the file list");

const files = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(DIST_PREFIX));
if (files.length === 0) throw new Error(`no files under ${DIST_PREFIX} at ${REF} — was dist/ committed?`);
console.log(`fetching ${files.length} files…`);

const queue = [...files];
let done = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const res = await fetchOk(`https://raw.githubusercontent.com/${REPO}/${REF}/${entry.path}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      // The git tree carries each blob's byte size — verify the download
      // against it so a truncated body can never ship a corrupt wasm/zkey.
      if (entry.size !== undefined && bytes.length !== entry.size) {
        throw new Error(`size mismatch for ${entry.path}: got ${bytes.length}, tree says ${entry.size}`);
      }
      const target = join(ROOT, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      done += 1;
    }
  })
);
if (!(await distPresent())) throw new Error("fetch finished but dist/ still looks wrong");
console.log(`fetched ${done}/${files.length} files into ${DIST_PREFIX}`);
