/**
 * A transaction hash, rendered as a link to stellar.expert.
 *
 * Falls back to plain text when the configured network has no public explorer
 * (`explorer.ts`'s `txUrl` returns `undefined`) rather than rendering a link
 * that would 404.
 *
 * Opens in a new tab: the wallet holds live session state and, on the SPP
 * rail, an exclusive OPFS storage lock that only clears on reload — navigating
 * away mid-session and coming back is a genuinely disruptive path here, not
 * just an inconvenience (see `spp.ts`'s connect/teardown notes).
 */
import { truncateHash } from "../lib/format.js";
import { txUrl } from "../lib/explorer.js";

export interface TxLinkProps {
  hash: string;
  /** Override the displayed text; defaults to the truncated hash. */
  label?: string;
  className?: string;
}

export default function TxLink({ hash, label, className }: TxLinkProps) {
  const text = label ?? truncateHash(hash);
  const href = txUrl(hash);

  if (!href) {
    return (
      <span className={className} title={hash}>
        {text}
      </span>
    );
  }

  return (
    <a
      className={["tx-link", className].filter(Boolean).join(" ")}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`View ${hash} on stellar.expert`}
    >
      {text}
    </a>
  );
}
