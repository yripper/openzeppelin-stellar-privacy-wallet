import { defineConfig } from "vitest/config";

/**
 * Kept separate from vite.config.ts: unit tests run in plain Node (no
 * react()/nodePolyfills() plugins, no dev-server headers needed) and rely on
 * `fake-indexeddb` to provide the `indexedDB` global that `idb-keyval`
 * (used by src/lib/privacy-bundle.ts) expects — jsdom does NOT implement
 * IndexedDB, and WebCrypto (used by src/lib/backup.ts) is natively available
 * in Node, so no DOM environment is needed either.
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
