/**
 * The display treatment for a balance: a large whole figure, a de-emphasised
 * 7-digit fraction, and the unit — see `format.ts`'s `splitStroops` for why
 * the fraction is never trimmed here.
 *
 * `reveal` is not decoration. An amount the wallet decrypted client-side (a
 * confidential balance, an inbound transfer) resolves out of blur as it
 * mounts, because that is literally what just happened to it. An amount the
 * wallet CANNOT decrypt (`"sealed"` — someone else's transfer, where we hold
 * neither the viewing key nor the sender's ephemeral scalar) stays blurred
 * permanently: the blur is the true state of the reader's knowledge, not a
 * loading placeholder that will eventually resolve.
 */
import { splitStroops } from "../lib/format.js";

export type Reveal = "plain" | "decrypted" | "sealed";

export interface AmountProps {
  stroops: bigint;
  /** Force a leading `+`/`-`. Balances are unsigned; ledger entries are signed. */
  signed?: boolean;
  reveal?: Reveal;
  /** Extra classes for the wrapper, e.g. a smaller scale in a table row. */
  className?: string;
}

export default function Amount({
  stroops,
  signed = false,
  reveal = "plain",
  className,
}: AmountProps) {
  const { sign, whole, frac } = splitStroops(stroops);
  const prefix = signed ? (sign === "-" ? "−" : "+") : sign === "-" ? "−" : "";
  const classes = ["amount", reveal === "plain" ? undefined : reveal, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes}>
      {prefix}
      {whole}
      <span className="frac">.{frac}</span>
      <span className="unit">XLM</span>
    </span>
  );
}
