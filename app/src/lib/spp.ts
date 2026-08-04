/**
 * Shielded Pool (SPP) rail orchestrator.
 *
 * Thin glue over OUR FORK of the `stellar-private-payments` browser SDK
 * (vendored at `vendor/stellar-private-payments`, Circom/Groth16 proving
 * inside the SDK's own worker — no bb.js, no SharedArrayBuffer). The fork
 * makes the passkey smart account (`C…`) the pool identity itself — the
 * `transact` sender, the registry owner, and the withdraw recipient — so
 * there is NO session `G…` account, no friendbot funding, and no staging
 * hops. Two seams carry it (see `vendor/stellar-private-payments/UPSTREAM.md`
 * and the `feat(spp-sdk)` commits):
 *
 * - `AccountOptions.txSource`: the kit's deployer `G…` sources the SDK's
 *   simulation envelopes (sequence + fees) while `userAddress` stays the
 *   C-address identity.
 * - `WalletSigner.executeTransaction`: the SDK hands the prepared invocation
 *   back to `spp-signer.ts`, which rebuilds it via `buildCtInvokeTx` and runs
 *   `kit.signAndSubmit` — passkey-signed auth entry, fee-sponsoring relayer —
 *   exactly like every CT rail write. The session ed25519 keypair survives
 *   ONLY as the key-derivation secret (`signMessage`), never as an account.
 *
 * ## Lifecycle
 *
 * ```
 * init() -> Storage.open(/spp/workers/storage-worker.js)
 *        -> bootnodeRequired(rpcUrl, storage)          (probe, for reporting)
 *        -> Client.new({rpcUrl, storage, proverWorkerUrl, bootnodeUrl})
 *        -> client.sync()                               (full historical sync)
 *        -> client.account({networkPassphrase, userAddress: walletC,
 *                           txSource: kit.deployerPublicKey}, signer)
 *        -> account.pool({poolContract: TESTNET.spp.pool})
 * ```
 *
 * `bootnodeUrl` is OUR OWN api's bootnode-protocol endpoint (`POST /rpc`,
 * `docs/modules/api.md`), NOT Nethermind's — theirs is dead (allow-list drift,
 * every request `-32602`), and ours serves the complete recovered pool history
 * (Task 8.5's 518-event backfill). The SDK reaches for it exactly when the main
 * Soroban RPC's retention window can't cover the deployment ledger
 * (`sdk/client/src/sync.rs:455-474`'s `catch_up`: `Indexer::init` →
 * `is_rpc_sync_gap` → `bootnode_catch_up` → re-init on the main RPC), and
 * leaves it on the `-32002` retention-handoff our tip returns.
 *
 * ## Money flow (all amounts bigint stroops, never floats)
 *
 * ```
 * smart account (C…) --pool.deposit (sender = C…)--> shielded
 * shielded --pool.transfer(recipient C…)--> recipient's shielded notes
 * shielded --pool.withdraw(_, wallet C…)--> smart account (C…)
 * ```
 *
 * Deposits pull straight from the smart account's public XLM (the pool's
 * `token_client.transfer(&sender, &pool, amount)` with the passkey authorizing
 * `sender`); withdrawals pay the smart account directly. Recipients are
 * addressed by their wallet `C…` address, which is what `registerPublicKeys`
 * now publishes as the registry owner.
 */
import { rpc } from "@stellar/stellar-sdk";
import { TESTNET } from "@privacy-wallet/shared";
import type {
  Account,
  Client,
  ClientNewOptions,
  PrivatePool,
  Storage,
} from "stellar-private-payments";

import { kit } from "./kit.js";
import { API_URL } from "./api-url.js";
import { SessionSigner, sessionKeypair } from "./spp-signer.js";

/** The SDK module, loaded lazily (its wasm glue + 2 MB `.wasm` are not worth paying for until the Shielded tab opens). */
type SppSdk = typeof import("stellar-private-payments");

/**
 * Vendored SDK asset paths (`app/scripts/vendor-spp.mjs` copies the package's
 * whole `dist/` tree to `public/spp/`, preserving `workers/`↔`circuits/`
 * siblinghood — `prover-worker.js` resolves its Circom artifacts as
 * `new URL('../circuits/', import.meta.url)`).
 *
 * Passed explicitly rather than letting `js/index.js` default them off its own
 * `import.meta.url`: those defaults point into `node_modules` (fine in dev,
 * broken after a production bundle moves the wrapper into a hashed chunk and
 * emits the worker bootstraps without their `-module.js`/`_bg.wasm` siblings).
 */
const STORAGE_WORKER_PATH = "/spp/workers/storage-worker.js";
const PROVER_WORKER_PATH = "/spp/workers/prover-worker.js";

/** Our api's SPP bootnode-protocol endpoint (`api/src/modules/bootnode/routes.ts`). */
export const SPP_BOOTNODE_URL = `${API_URL}/rpc`;

/** The SDK's in-flight progress `CustomEvent` (`sdk/web/src/client/execute/progress.rs:8`). */
export const SPP_PROGRESS_EVENT = "stellar-private-payments:tx-progress";

/** `CustomEvent.detail` shape for {@link SPP_PROGRESS_EVENT}. */
export interface SppProgressDetail {
  flow: string;
  stage: string;
  message: string;
  current?: number;
  total?: number;
}

/**
 * Result envelope every pool write returns
 * (`sdk/web/src/client/execute/mod.rs:29-45`) — note it RESOLVES on failure
 * rather than rejecting, so callers must branch on `status`.
 */
export type SppExecuteResult =
  | { status: "ok"; hashes: string[] }
  | { status: "failed"; hashes: string[]; message: string; code?: number }
  | { status: "aspNotReady" };

/** A recipient's registry entry (`sdk/types/src/lib.rs:139-148,187-193`). */
export interface SppRecipientLookup {
  entry: { address: string; noteKey: string; encryptionKey: string; ledger: number } | null;
  registryFullySynced: boolean;
  networkTipLedger: number;
  registryLastFullyIndexedLedger: number;
}

/**
 * Coarse connect phases, reported through {@link SppConnectOptions.onPhase}.
 *
 * Connecting is a multi-step, minutes-long operation on a cold profile (the
 * full historical sync alone walks the whole deployment through the bootnode),
 * and the SDK's own progress `CustomEvent` only covers *transaction* flows —
 * without this the UI would sit on one undifferentiated spinner.
 */
export type SppConnectPhase =
  | "loading-sdk"
  | "opening-storage"
  | "probing-bootnode"
  | "starting-client"
  | "syncing-history"
  | "deriving-keys"
  | "opening-pool";

export interface SppConnectOptions {
  onPhase?: (phase: SppConnectPhase) => void;
}

/** Human-readable copy for each {@link SppConnectPhase}. */
export const SPP_CONNECT_PHASE_LABELS: Record<SppConnectPhase, string> = {
  "loading-sdk": "Loading the shielded-pool prover…",
  "opening-storage": "Opening local encrypted storage…",
  "probing-bootnode": "Checking how far back the network RPC remembers…",
  "starting-client": "Starting the shielded client…",
  "syncing-history": "Syncing pool history…",
  "deriving-keys": "Deriving your privacy keys…",
  "opening-pool": "Opening the XLM pool…",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** UI-ready snapshot. Every amount is stroops (bigint). */
export interface SppView {
  /** Shielded balance in the XLM pool, stroops (`pool.balance()`). */
  shielded: bigint;
  /** Same figure re-derived from `account.portfolio()` — an independent cross-check on `shielded`. */
  portfolioShielded: bigint;
  /** Unspent notes backing `shielded`. */
  unspentNotes: number;
  /** Whether this wallet's note/encryption keys are on the deployment registry (required to RECEIVE). */
  registered: boolean;
}

/**
 * Narrow the SDK's `unknown` execute envelope without trusting it blindly.
 *
 * Exported for unit testing: this is the boundary where the SDK's
 * resolves-on-failure convention (`{status:"failed"}` is a RESOLVED promise,
 * not a rejection) becomes a typed value callers must branch on.
 */
export function asExecuteResult(value: unknown): SppExecuteResult {
  const status = (value as { status?: unknown } | null)?.status;
  if (status === "ok") {
    return { status: "ok", hashes: ((value as { hashes?: string[] }).hashes ?? []) as string[] };
  }
  if (status === "aspNotReady") {
    return { status: "aspNotReady" };
  }
  if (status === "failed") {
    const failed = value as { hashes?: string[]; message?: string; code?: number };
    return {
      status: "failed",
      hashes: failed.hashes ?? [],
      message: failed.message ?? "Transaction failed",
      code: failed.code,
    };
  }
  return { status: "failed", hashes: [], message: `Unrecognized SDK result: ${String(status)}` };
}

/**
 * The SDK's own `index.d.ts` declares its client factory as
 * `const Client: { new(options: ClientNewOptions): Promise<Client>; … }` —
 * inside a type literal, an UNQUOTED `new(…)` is a TypeScript *construct
 * signature*, so the declaration promises `new Client(opts)` and hides the
 * `.new` method that actually exists. At runtime the package exports a plain
 * object, `export const Client = { new: newClient, contractConfig: … }`
 * (`stellar-private-payments/js/index.js`), which is not constructible. Quoting
 * the key here makes it an ordinary method and restores type-checked access to
 * the real call.
 */
interface SppClientFactory {
  "new"(options: ClientNewOptions): Promise<Client>;
}

let sdkPromise: Promise<SppSdk> | undefined;

/** Load + `init()` the SPP wasm SDK exactly once per page. */
export function loadSppSdk(): Promise<SppSdk> {
  sdkPromise ??= (async () => {
    const sdk = await import("stellar-private-payments");
    await sdk.default();
    return sdk;
  })();
  return sdkPromise;
}

/**
 * Ask the browser to keep our OPFS database off the eviction list. Purely a UX
 * nicety — the SDK re-syncs from chain (through our bootnode) if it's ever
 * cleared — so a rejection is not an error.
 */
async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

function absoluteUrl(path: string): string {
  return new URL(path, globalThis.location.origin).href;
}

/**
 * Orchestrates the shielded rail for one wallet. One instance per session (see
 * {@link connectSppRail}) — it owns an OPFS-backed storage worker and a prover
 * worker, neither of which tolerates being duplicated against the same DB.
 */
export class SppRail {
  readonly server: rpc.Server;

  private constructor(
    /** The wallet's smart-account `C…` address — the pool identity: sender, registry owner, and withdraw recipient. */
    readonly walletAddress: string,
    private readonly client: Client,
    private readonly account: Account,
    private readonly pool: PrivatePool,
    private readonly storage: Storage,
    /** What `bootnodeRequired()` answered at connect time — i.e. whether the main RPC alone could serve history. */
    readonly bootnodeWasRequired: boolean
  ) {
    this.server = new rpc.Server(TESTNET.rpcUrl);
  }

  /**
   * Full connect: wasm init → storage worker → bootnode probe → client → full
   * historical sync (through {@link SPP_BOOTNODE_URL}) → key-derivation signature
   * → pool session.
   *
   * @param sppRootSecret - `PrivacyBundle.sppRootSecret`. Never logged, never leaves this process.
   * @param walletAddress - The wallet's smart-account `C…` address.
   */
  static async connect(
    sppRootSecret: string,
    walletAddress: string,
    options: SppConnectOptions = {}
  ): Promise<SppRail> {
    const phase = (next: SppConnectPhase): void => options.onPhase?.(next);

    phase("loading-sdk");
    const sdk = await loadSppSdk();
    await requestPersistentStorage();

    phase("opening-storage");
    const storage = await sdk.Storage.open({ workerUrl: absoluteUrl(STORAGE_WORKER_PATH) });

    phase("probing-bootnode");
    const bootnodeWasRequired = await sdk.bootnodeRequired(TESTNET.rpcUrl, storage);

    phase("starting-client");
    const client = await (sdk.Client as unknown as SppClientFactory).new({
      rpcUrl: TESTNET.rpcUrl,
      storage,
      proverWorkerUrl: absoluteUrl(PROVER_WORKER_PATH),
      bootnodeUrl: SPP_BOOTNODE_URL,
    });

    // Explicit, awaitable full catch-up (NOT `backgroundSync()`): this is the
    // call that walks the whole deployment history through our bootnode and
    // then hands off to the main RPC. Leaving the client in inline-sync mode
    // also means every later pool op self-syncs before proving.
    phase("syncing-history");
    await client.sync();

    phase("deriving-keys");
    const keypair = sessionKeypair(sppRootSecret);
    const signer = new SessionSigner(keypair, TESTNET.networkPassphrase);

    // The wallet's C-address is the pool identity; the kit's deployer G only
    // sources the SDK's simulation envelopes (forked `txSource` — the actual
    // submission is rebuilt and relayer-sponsored by `executeTransaction`).
    // `signMessage` still signs KEY_DERIVATION_MESSAGE with the session
    // keypair, deterministically, so the derived privacy keys are byte-for-byte
    // the ones this wallet has always had — old notes stay spendable.
    const account = await client.account(
      {
        networkPassphrase: TESTNET.networkPassphrase,
        userAddress: walletAddress,
        txSource: kit.deployerPublicKey,
      },
      signer
    );

    phase("opening-pool");
    const pool = await account.pool({ poolContract: TESTNET.spp.pool });

    return new SppRail(walletAddress, client, account, pool, storage, bootnodeWasRequired);
  }

  /** Catch local storage up to the chain tip (bootnode leg included when the RPC can't reach back far enough). */
  async resync(): Promise<void> {
    await this.client.sync();
  }

  /**
   * One snapshot for the UI.
   *
   * Syncs FIRST: every shielded figure below (`balance`, `portfolio`, `notes`,
   * `isRegistered`) is read out of the local OPFS database, not off-chain, so
   * without a catch-up an incoming transfer — or this wallet's own just-submitted
   * one — would never show up. A sync failure propagates rather than silently
   * returning stale numbers.
   */
  async refresh(): Promise<SppView> {
    await this.resync();

    const [shielded, portfolio, notes, registered] = await Promise.all([
      this.pool.balance(),
      this.account.portfolio(),
      this.pool.notes(),
      this.account.isRegistered(),
    ]);

    const portfolioRows = (Array.isArray(portfolio) ? portfolio : []) as Array<{
      poolContractId?: string;
      amount?: string;
    }>;
    const portfolioShielded = portfolioRows
      .filter((row) => row.poolContractId === TESTNET.spp.pool)
      .reduce((total, row) => total + BigInt(row.amount ?? "0"), 0n);

    const noteRows = (Array.isArray(notes) ? notes : []) as Array<{ spent?: boolean }>;

    return {
      shielded,
      portfolioShielded,
      unspentNotes: noteRows.filter((note) => !note.spent).length,
      registered,
    };
  }

  /** Publish this wallet's note + encryption public keys so others can send to its `C…` address. One-shot per wallet. */
  async registerPublicKeys(): Promise<string> {
    return this.account.registerPublicKeys({});
  }

  /** Look a recipient up in the locally-synced registry. `entry === null` means "not registered (or not synced yet)". */
  async lookupRecipient(address: string): Promise<SppRecipientLookup> {
    const lookup = (await this.client.recipientLookup(address)) as SppRecipientLookup | undefined;
    return (
      lookup ?? {
        entry: null,
        registryFullySynced: false,
        networkTipLedger: 0,
        registryLastFullyIndexedLedger: 0,
      }
    );
  }

  /** Wallet public XLM → shielded notes. The pool pulls straight from the smart account (passkey-authorized). */
  async shield(stroops: bigint): Promise<SppExecuteResult> {
    return asExecuteResult(await this.pool.deposit(stroops));
  }

  /** Shielded → another wallet's shielded notes, addressed by their wallet `C…` address. */
  async sendShielded(recipient: string, stroops: bigint): Promise<SppExecuteResult> {
    return asExecuteResult(await this.pool.transfer(recipient, stroops));
  }

  /** Shielded → public XLM, paid directly back to the smart account. */
  async unshield(stroops: bigint): Promise<SppExecuteResult> {
    return asExecuteResult(await this.pool.withdraw(stroops, this.walletAddress));
  }

  /**
   * Release what the SDK actually lets us release.
   *
   * **Currently unwired — nothing calls this.** The one path that used to
   * (disposing a previous rail on a wallet switch) was removed once it became
   * clear the switch cannot be done safely in-page at all; the operative
   * protection is now {@link connectSppRail}'s `SppWalletSwitchError` reject.
   * This is kept, and kept honest, because it is the correct thing to call the
   * day the SDK grows a real teardown — not because it is doing any work today.
   *
   * **This does NOT terminate the storage or prover workers, and cannot.**
   * `Storage.open()` spawns a fresh worker per call
   * (`sdk/web/src/storage.rs:75-87`) and `Client.new` immediately takes a
   * `storage.fork()` of the bridge plus a prover bridge of its own
   * (`sdk/web/src/client/mod.rs`); the package's JS wrapper then returns a
   * plain object exposing only `{backgroundSync, stopBackgroundSync, sync,
   * operationalFeed, account, recipientLookup, aspState, allContractsData,
   * verifySelectiveDisclosure}` (`stellar-private-payments/js/index.js`'s
   * `wrapClient`) — no `free`, no dispose. So the client's forks (and with them
   * both workers) outlive anything we can do here.
   *
   * Consequence, enforced in {@link connectSppRail}: a wallet switch requires a
   * PAGE RELOAD. Opening a second `Storage.open()` in the same page would put
   * two storage workers on the same `spp.db`, against the SDK's own "call once
   * per page session" instruction.
   *
   * What this does do: `stopBackgroundSync()` (a no-op here — this rail never
   * starts background sync, so `stop_background_sync` finds no handle — but
   * correct to call if that ever changes), and `free()` on the one storage
   * handle we own, releasing our wasm-side bridge allocation. `free` exists on
   * the runtime object (it is the wasm-bindgen `Storage` class,
   * `dist/stellar_private_payments_sdk_web.d.ts`) but is missing from the
   * package's hand-written `js/types/storage.d.ts`, hence the guarded cast.
   */
  destroy(): void {
    try {
      this.client.stopBackgroundSync();
    } catch (error) {
      // Already torn down (or never started) — nothing to recover from here.
      console.warn("SPP client teardown:", errorMessage(error));
    }
    try {
      (this.storage as unknown as { free?: () => void }).free?.();
    } catch (error) {
      console.warn("SPP storage handle release:", errorMessage(error));
    }
  }
}

/**
 * Thrown by {@link connectSppRail} when a DIFFERENT wallet/session is requested
 * while a rail is already live in this page.
 *
 * The SPP SDK gives no way to shut a client's storage/prover workers down (see
 * {@link SppRail.destroy}), so rebuilding in place would leave a second storage
 * worker on the same OPFS `spp.db`. A reload is the only safe switch, and this
 * error exists so the UI says exactly that instead of the rail silently
 * misbehaving.
 */
export class SppWalletSwitchError extends Error {
  constructor() {
    super(
      "Switching wallets needs a page reload: the shielded pool SDK keeps its storage worker " +
        "open for the lifetime of the page."
    );
    this.name = "SppWalletSwitchError";
  }
}

/**
 * One `SppRail` per session address, shared page-wide.
 *
 * Two live rails on the same OPFS database race each other (the SDK says so
 * itself: "call [stopBackgroundSync] before rebuilding this Client so a new
 * instance does not race the old loop on the same storage DB"), and React
 * StrictMode double-invokes mount effects in dev — so connection is memoized
 * here rather than tied to a component's lifetime.
 *
 * `onPhase` is deliberately NOT captured once: a cache hit re-points the entry
 * at the LATEST caller's listener and immediately replays the current phase.
 * Without that, a StrictMode remount would leave the UI subscribed to the
 * discarded first effect's (already-cancelled) callback and the connect
 * progress would appear frozen at its first step — observed live during this
 * task's gate run. A caller that passes no `onPhase` LEAVES the existing
 * listener alone rather than clearing it, so a non-subscribing call can't
 * silently detach the live subscriber (same failure class, opposite direction).
 *
 * Requesting a DIFFERENT key while a rail is live throws
 * {@link SppWalletSwitchError} instead of building a second rail — see
 * {@link SppRail.destroy} for why no in-page teardown is possible.
 */
interface ActiveRail {
  key: string;
  rail: Promise<SppRail>;
  phase: SppConnectPhase;
  onPhase?: (phase: SppConnectPhase) => void;
}

let active: ActiveRail | undefined;

export function connectSppRail(
  sppRootSecret: string,
  walletAddress: string,
  options?: SppConnectOptions
): Promise<SppRail> {
  const key = `${sessionKeypair(sppRootSecret).publicKey()}:${walletAddress}`;

  if (active?.key === key) {
    // Only ever ADD/replace a listener — assigning `options?.onPhase` blindly
    // would unsubscribe the live one whenever a caller doesn't pass a callback.
    if (options?.onPhase) active.onPhase = options.onPhase;
    options?.onPhase?.(active.phase);
    return active.rail;
  }

  if (active) {
    // A different wallet/session, with a rail already holding this page's
    // storage + prover workers open. There is no SDK teardown to call, so
    // refuse rather than double-open the OPFS database.
    return Promise.reject(new SppWalletSwitchError());
  }

  const entry: ActiveRail = {
    key,
    phase: "loading-sdk",
    onPhase: options?.onPhase,
    rail: undefined as unknown as Promise<SppRail>,
  };
  entry.rail = SppRail.connect(sppRootSecret, walletAddress, {
    onPhase: (next) => {
      entry.phase = next;
      entry.onPhase?.(next);
    },
  });
  // A failed connect must not be cached: leave the slot empty so remounting
  // the tab (or a retry after starting the API server) attempts it again.
  entry.rail.catch(() => {
    if (active === entry) active = undefined;
  });

  active = entry;
  return entry.rail;
}
