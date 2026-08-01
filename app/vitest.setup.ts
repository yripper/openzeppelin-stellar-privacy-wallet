// Polyfills `globalThis.indexedDB` for `idb-keyval` (src/lib/privacy-bundle.ts)
// under plain Node — jsdom does not implement IndexedDB, so this is required
// even though the rest of the suite needs no DOM.
import "fake-indexeddb/auto";
