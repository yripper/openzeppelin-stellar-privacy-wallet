/**
 * Amount and address formatting for the CT rail UI.
 *
 * Amounts are handled as bigint stroops everywhere except at the very edges
 * (parsing a text input, rendering a label) — never float math on stroops,
 * per this task's brief. 1 XLM = 10_000_000 stroops (7 decimal places),
 * matching the underlying SAC's own units (see `scripts/smoke-ct.ts`'s
 * `DEPOSIT = 100_0000000n` convention).
 */

const STROOPS_PER_XLM = 10_000_000n;

/** Render stroops as an XLM decimal string, trimming trailing zeros (never scientific notation, never a float). */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = abs % STROOPS_PER_XLM;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  const body = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Parse a user-entered XLM decimal string into stroops. Throws on anything that isn't a non-negative decimal with at most 7 places. */
export function xlmToStroops(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error(`Invalid XLM amount: "${input}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole!) * STROOPS_PER_XLM + BigInt(frac.padEnd(7, "0"));
}

/** `GABC…XYZ` — first 6 + last 6 characters, for compact display. */
export function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/** `abcdef01…` — first 8 characters, for compact tx-hash display. */
export function truncateHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 10)}…`;
}
