/**
 * Whether this browser has ever exported an encrypted backup for a given
 * wallet — the flag behind the "back up your keys" reminder banner.
 *
 * Onboarding used to force the backup step before the wallet home was
 * reachable. It no longer does: on testnet the cost of losing a throwaway
 * wallet is nil, and a hard gate in front of a first-run demo buys safety
 * nobody needed at the price of the first thing a new user sees. The reminder
 * stays until an export actually happens, so the prompt survives a reload
 * instead of being dismissible-and-forgotten.
 *
 * Deliberately localStorage, not idb-keyval: this is a UI hint, not key
 * material, and it must be readable synchronously during render so the banner
 * doesn't flash in on every mount. Losing it is harmless — the worst case is
 * one extra reminder to re-export a backup the user already has.
 *
 * NOT proof that a usable backup exists. It records that this browser
 * downloaded one; it cannot know the file still exists or that the passphrase
 * is remembered.
 */

const KEY_PREFIX = "privacy-wallet:backed-up:";

function key(contractId: string): string {
  return `${KEY_PREFIX}${contractId}`;
}

/** Safe on every platform: Safari in private mode throws on localStorage access rather than returning null. */
export function hasBackedUp(contractId: string | undefined): boolean {
  if (!contractId) return true; // nothing to warn about without a wallet
  try {
    return window.localStorage.getItem(key(contractId)) !== null;
  } catch {
    return false;
  }
}

export function markBackedUp(contractId: string | undefined): void {
  if (!contractId) return;
  try {
    window.localStorage.setItem(key(contractId), new Date().toISOString());
  } catch {
    // A wallet the user can't be reminded about is better than a crash on export.
  }
}
