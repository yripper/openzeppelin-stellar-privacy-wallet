#!/usr/bin/env node
// Production static file server for the built wallet SPA (`app/dist`).
// Sets the same COOP/COEP cross-origin-isolation headers `vite.config.ts`'s
// dev/preview servers set (bb.js's multithreaded UltraHonk prover needs
// `crossOriginIsolated === true`, see that file's module doc) plus CORP on
// the two vendored asset trees (`/vendor/bb/*`, `/spp/*`) so a COEP document
// may still load them as cross-origin sub-resources. Deliberately dependency-free
// (plain `node:http`) — this file is the whole deploy artifact for the `app`
// Railway service, no build step of its own.
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const DIST_DIR = fileURLToPath(new URL("./dist", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".gz": "application/gzip",
  ".txt": "text/plain; charset=utf-8",
};

/** Resolves a request path to a real file under `DIST_DIR`, or `null` (SPA fallback territory). Blocks `../` escapes. */
function resolveFile(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^([/\\]?\.\.[/\\])+/, "");
  const filePath = join(DIST_DIR, safePath);
  return existsSync(filePath) && statSync(filePath).isFile() ? filePath : null;
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  // Cross-origin isolation on every response (see module doc above).
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  if (pathname.startsWith("/vendor/bb/") || pathname.startsWith("/spp/")) {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }

  // SPA fallback: any path that isn't a real file under dist/ serves
  // index.html so react-router's client-side routes resolve on a hard load.
  const filePath = resolveFile(pathname) ?? join(DIST_DIR, "index.html");
  res.setHeader("Content-Type", MIME_TYPES[extname(filePath)] ?? "application/octet-stream");
  createReadStream(filePath)
    .on("error", () => {
      res.statusCode = 404;
      res.end("Not found");
    })
    .pipe(res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[app] serving ${DIST_DIR} on :${PORT}`);
});
