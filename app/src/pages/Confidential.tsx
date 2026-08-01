/**
 * The Confidential Token wallet dashboard: balances + register/deposit/
 * merge/withdraw quick actions, send, and activity — composed from
 * `CtProvider` + `BalanceCard`/`SendForm`/`ActivityFeed`. Rendered inside
 * `Shell`'s "Wallet" tab.
 */
import { CtProvider } from "../providers/CtProvider.js";
import BalanceCard from "../components/BalanceCard.js";
import SendForm from "../components/SendForm.js";
import ActivityFeed from "../components/ActivityFeed.js";

export default function Confidential() {
  return (
    <CtProvider>
      <div className="confidential stack">
        <BalanceCard />
        <SendForm />
        <ActivityFeed />
      </div>
    </CtProvider>
  );
}
