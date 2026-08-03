import { BrowserRouter, Route, Routes } from "react-router";

import { WalletProvider } from "./providers/WalletProvider.js";
import Landing from "./pages/Landing.js";
import Onboarding from "./pages/Onboarding.js";
import BackupExport from "./pages/BackupExport.js";
import Connect from "./pages/Connect.js";
import RestoreBackup from "./pages/RestoreBackup.js";
import RequireWallet from "./pages/RequireWallet.js";
import Shell from "./pages/Shell.js";

export default function App() {
  return (
    <BrowserRouter>
      <WalletProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/backup-export" element={<BackupExport />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/restore" element={<RestoreBackup />} />
          <Route
            path="/wallet"
            element={
              <RequireWallet>
                <Shell />
              </RequireWallet>
            }
          />
        </Routes>
      </WalletProvider>
    </BrowserRouter>
  );
}
