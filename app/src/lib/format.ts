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

export interface AmountParts {
  /** `"-"` or `""` — never bundled into `whole`, so the sign can be styled apart from the figure. */
  sign: string;
  /** Whole lumens, grouped in threes with `,`. */
  whole: string;
  /** Exactly 7 digits, never trimmed. */
  frac: string;
}

/**
 * Split stroops for the display treatment `<Amount>` renders: a large whole
 * figure, a de-emphasised fraction, and a separate sign.
 *
 * Unlike {@link stroopsToXlm} this does NOT trim trailing zeros — a balance
 * card is a ledger reading, where `50.0000000` and `50` claim different
 * precision, and a column of amounts whose decimal points don't line up is
 * unreadable. Grouping is hard-coded to `,` rather than locale-derived so the
 * same balance renders identically for every user (and in tests).
 */
export function splitStroops(stroops: bigint): AmountParts {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = (abs / STROOPS_PER_XLM).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return {
    sign: negative ? "-" : "",
    whole,
    frac: (abs % STROOPS_PER_XLM).toString().padStart(7, "0"),
  };
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
