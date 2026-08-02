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

/** Resolves an ALREADY-DECODED request path to a real file under `DIST_DIR`, or `null` (SPA fallback territory). Blocks `../` escapes. */
function resolveFile(decodedPathname) {
  const safePath = normalize(decodedPathname).replace(/^([/\\]?\.\.[/\\])+/, "");
  const filePath = join(DIST_DIR, safePath);
  return existsSync(filePath) && statSync(filePath).isFile() ? filePath : null;
}

const INDEX_HTML = join(DIST_DIR, "index.html");

const server = createServer((req, res) => {
  // Cross-origin isolation on every response (see module doc above) — set
  // before any early return so even error responses carry it.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method not allowed");
    return;
  }

  // `decodeURIComponent` throws `URIError` on malformed percent-encoding
  // (`%`, `%zz`, a truncated multi-byte sequence like `%E0%A4%A` — routine
  // scanner/bot traffic, not an edge case). Node has no default error
  // boundary around a synchronous throw in an http request listener: it
  // becomes an uncaught exception and takes the whole process down.
  // Reproduced locally pre-fix; caught here so it's a 400, not an outage.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  if (pathname.startsWith("/vendor/bb/") || pathname.startsWith("/spp/")) {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }

  // SPA fallback: any path that isn't a real file under dist/ serves
  // index.html so react-router's client-side routes resolve on a hard load.
  const filePath = resolveFile(pathname) ?? INDEX_HTML;

  // Vite's `/assets/*` output is content-hashed (safe to cache forever);
  // everything else — including index.html itself, both direct hits and
  // the SPA fallback above — must be revalidated every time, since
  // index.html is what points at the current deploy's hashed asset names.
  res.setHeader(
    "Cache-Control",
    pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  );
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
