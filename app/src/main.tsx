import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
import { ensureBrowserBackend } from "./lib/bb-loader.js";
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
