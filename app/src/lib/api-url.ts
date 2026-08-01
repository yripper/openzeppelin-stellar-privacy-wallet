/**
 * `@grantfox/api`'s base URL — the single source of truth for every browser
 * call into our own backend: the CT rail's indexer adapter + activity feed
 * (`ct.ts`, `ct-indexer.ts`, `ActivityFeed.tsx`) and the SPP rail's bootnode
 * endpoint (`spp.ts`'s `SPP_BOOTNODE_URL`).
 *
 * Vite only exposes `VITE_`-prefixed vars, and only from a real `.env` file —
 * see `app/.env.example`.
 */
export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3000";
