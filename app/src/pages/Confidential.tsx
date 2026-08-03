/**
 * The Confidential Token wallet dashboard: balances, then ONE action panel
 * switched by a segmented control, then activity. Rendered inside `Shell`'s
 * "Wallet" tab.
 *
 * The three actions are mutually exclusive — you are either sending, putting
 * money in, or taking it out — so they share one form area instead of
 * stacking three always-open forms down the page. Send leads because it is
 * what the wallet is for; deposit and withdraw are the boundary operations.
 */
import { useState } from "react";

import { CtProvider } from "../providers/CtProvider.js";
import BalanceCard from "../components/BalanceCard.js";
import SendForm from "../components/SendForm.js";
import MoveFunds from "../components/MoveFunds.js";
import ActivityFeed from "../components/ActivityFeed.js";

const ACTIONS = ["Send", "Deposit", "Withdraw"] as const;
type CtAction = (typeof ACTIONS)[number];

export default function Confidential() {
  const [action, setAction] = useState<CtAction>("Send");

  return (
    <CtProvider>
      <div className="confidential stack">
        <BalanceCard />

        <section className="send-form">
          <div className="seg" role="group" aria-label="Confidential token actions">
            {ACTIONS.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={name === action}
                onClick={() => setAction(name)}
              >
                {name}
              </button>
            ))}
          </div>

          {action === "Send" ? (
            <SendForm />
          ) : (
            <MoveFunds mode={action === "Deposit" ? "deposit" : "withdraw"} />
          )}
        </section>

        <ActivityFeed />
      </div>
    </CtProvider>
  );
}
