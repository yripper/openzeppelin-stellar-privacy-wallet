import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
import { ensureBrowserBackend } from "./lib/bb-loader.js";
// Self-hosted so the wallet makes no third-party font request — a privacy
// product leaking "who is using it" to a font CDN would undercut its own
// claim, and `server.mjs`'s COOP/COEP isolation headers make cross-origin
// subresources a liability besides. Archivo ships the `wdth` axis in
// `standard.css` (`font-stretch: 62% 125%`), which the display scale uses;
// Martian Mono only needs `wght`.
import "@fontsource-variable/archivo/standard.css";
import "@fontsource-variable/martian-mono";
import "./index.css";

// Registers the native-ESM bb.js loader before any UltraHonk proving happens
// (Task 11/12). Idempotent and browser-only; cheap to call unconditionally.
ensureBrowserBackend();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
