/**
 * Shielded Pool (SPP) rail orchestrator.
 *
 * Thin glue over the `stellar-private-payments` browser SDK (Circom/Groth16
 * proving inside the SDK's own worker — no bb.js, no SharedArrayBuffer) plus
 * the session-account plumbing the SDK's G-address-only signing surface forces
 * on a passkey smart-account wallet (see `spp-signer.ts`'s module doc for the
 * full "why a session key" argument).
 *
 * ## Lifecycle
 *
 * ```
 * init() -> Storage.open(/spp/workers/storage-worker.js)
 *        -> bootnodeRequired(rpcUrl, storage)          (probe, for reporting)
 *        -> Client.new({rpcUrl, storage, proverWorkerUrl, bootnodeUrl})
 *        -> client.sync()                               (full historical sync)
 *        -> client.account({networkPassphrase, userAddress: sessionG}, signer)
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
 * smart account (C…) --kit.transfer(nativeSac)--> session (G…) --pool.deposit--> shielded
 * shielded --pool.transfer(recipient G…)--> recipient's shielded notes
 * shielded --pool.withdraw(_, session G…)--> session (G…) --SAC transfer--> smart account (C…)
 * ```
 *
 * The session account is a staging address, never a place to leave funds:
 * `sweepToWallet()` returns everything above the account's own minimum
 * balance to the smart account, signed by the session key.
 */
import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { TESTNET } from "@grantfox/shared";
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

/**
 * Kept back when sweeping the session account: 1 XLM base reserve (2 × the
 * 0.5 XLM testnet base reserve, for an account with no subentries — the ledger
 * rejects any operation that would drop below it) + 0.5 XLM of fee headroom so
 * the account can still pay for a later withdraw/sweep.
 */
const SESSION_RESERVE_STROOPS = 15_000_000n;

/** Inclusion fee for the session-signed sweep; `prepareTransaction` adds the Soroban resource fee on top. */
const SWEEP_INCLUSION_FEE = "100000";

const STROOPS_PER_XLM = 10_000_000n;

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

/** UI-ready snapshot. Every amount is stroops (bigint). */
export interface SppView {
  /** The `G…` session account SPP signs and settles through. */
  sessionAddress: string;
  /** Whether the session account exists on-chain yet (friendbot creates it). */
  sessionExists: boolean;
  /** Session account's public XLM, stroops. */
  sessionXlm: bigint;
  /** Shielded balance in the XLM pool, stroops (`pool.balance()`). */
  shielded: bigint;
  /** Same figure re-derived from `account.portfolio()` — an independent cross-check on `shielded`. */
  portfolioShielded: bigint;
  /** Unspent notes backing `shielded`. */
  unspentNotes: number;
  /** Whether this session's note/encryption keys are on the deployment registry (required to RECEIVE). */
  registered: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const scAddress = (address: string): xdr.ScVal => new Address(address).toScVal();
const scI128 = (amount: bigint): xdr.ScVal => nativeToScVal(amount, { type: "i128" });

/**
 * Convert stroops to the XLM `number` `kit.transfer` insists on, replicating
 * its own `xlmToStroops` (`resources/smart-account-kit/src/utils.ts:92-94`,
 * `BigInt(Math.round(xlm * 10_000_000))`) and refusing anything that would not
 * round-trip exactly — so a float never silently eats or invents stroops.
 */
export function stroopsToKitXlm(stroops: bigint): number {
  const xlm = Number(stroops) / Number(STROOPS_PER_XLM);
  if (BigInt(Math.round(xlm * Number(STROOPS_PER_XLM))) !== stroops) {
    throw new Error(`Amount ${stroops} stroops cannot be represented exactly as an XLM number`);
  }
  return xlm;
}

/** Narrow the SDK's `unknown` execute envelope without trusting it blindly. */
function asExecuteResult(value: unknown): SppExecuteResult {
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
    /** The wallet's smart-account `C…` address — the sweep destination. */
    readonly walletAddress: string,
    /** The `G…` session account SPP itself runs on. */
    readonly sessionAddress: string,
    private readonly keypair: Keypair,
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
    const sessionAddress = keypair.publicKey();
    const signer = new SessionSigner(keypair, TESTNET.networkPassphrase);

    // Triggers the SDK's one-time `signMessage(KEY_DERIVATION_MESSAGE)` when
    // this session's privacy keys aren't in local storage yet; deterministic,
    // so a restored backup reproduces the same keys.
    const account = await client.account(
      { networkPassphrase: TESTNET.networkPassphrase, userAddress: sessionAddress },
      signer
    );

    phase("opening-pool");
    const pool = await account.pool({ poolContract: TESTNET.spp.pool });

    return new SppRail(
      walletAddress,
      sessionAddress,
      keypair,
      client,
      account,
      pool,
      storage,
      bootnodeWasRequired
    );
  }

  /** Catch local storage up to the chain tip (bootnode leg included when the RPC can't reach back far enough). */
  async resync(): Promise<void> {
    await this.client.sync();
  }

  /** Existence + public XLM of the session account, read straight off the ledger entry (no simulation, no funded source needed). */
  async sessionState(): Promise<{ exists: boolean; xlm: bigint }> {
    const ledgerKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({
        accountId: Keypair.fromPublicKey(this.sessionAddress).xdrPublicKey(),
      })
    );
    const { entries } = await this.server.getLedgerEntries(ledgerKey);
    const entry = entries[0];
    if (!entry) return { exists: false, xlm: 0n };
    return { exists: true, xlm: BigInt(entry.val.account().balance().toString()) };
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

    const [session, shielded, portfolio, notes, registered] = await Promise.all([
      this.sessionState(),
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
      sessionAddress: this.sessionAddress,
      sessionExists: session.exists,
      sessionXlm: session.xlm,
      shielded,
      portfolioShielded,
      unspentNotes: noteRows.filter((note) => !note.spent).length,
      registered,
    };
  }

  /** Create the session account on testnet (friendbot). Idempotent-ish: a second call on a live account throws, so callers check `sessionExists` first. */
  async fundSessionFromFriendbot(): Promise<void> {
    await this.server.fundAddress(this.sessionAddress);
  }

  /** Move public XLM from the smart account to the session account (passkey-signed, via the SAC). */
  async moveToSession(stroops: bigint): Promise<string> {
    const result = await kit.transfer(
      TESTNET.nativeSac,
      this.sessionAddress,
      stroopsToKitXlm(stroops)
    );
    if (!result.success) {
      throw new Error(result.error.message);
    }
    return result.hash;
  }

  /**
   * Return every session-account stroop above {@link SESSION_RESERVE_STROOPS}
   * to the smart account, as a session-key-signed SAC `transfer` (a classic
   * payment cannot target a `C…` contract address).
   *
   * @returns The submitted transfer, or `undefined` when there's nothing above the reserve to sweep.
   */
  async sweepToWallet(): Promise<{ hash: string; amount: bigint } | undefined> {
    const { exists, xlm } = await this.sessionState();
    if (!exists) return undefined;
    const amount = xlm - SESSION_RESERVE_STROOPS;
    if (amount <= 0n) return undefined;

    const source = await this.server.getAccount(this.sessionAddress);
    const transaction = new TransactionBuilder(source, {
      fee: SWEEP_INCLUSION_FEE,
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(
        new Contract(TESTNET.nativeSac).call(
          "transfer",
          scAddress(this.sessionAddress),
          scAddress(this.walletAddress),
          scI128(amount)
        )
      )
      .setTimeout(120)
      .build();

    // `from` IS the transaction source, so source-account authorization covers
    // the SAC's `require_auth` — no auth entry to sign separately.
    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(this.keypair);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`Sweep submission failed: ${JSON.stringify(sent.errorResult?.result())}`);
    }
    const confirmed = await this.server.pollTransaction(sent.hash);
    if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Sweep did not confirm (${confirmed.status}, hash ${sent.hash})`);
    }
    return { hash: sent.hash, amount };
  }

  /** Publish this session's note + encryption public keys so others can send to its `G…` address. One-shot per session account. */
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

  /** Public session XLM → shielded notes. */
  async shield(stroops: bigint): Promise<SppExecuteResult> {
    return asExecuteResult(await this.pool.deposit(stroops));
  }

  /** Shielded → another wallet's shielded notes, addressed by their session `G…` address. */
  async sendShielded(recipient: string, stroops: bigint): Promise<SppExecuteResult> {
    return asExecuteResult(await this.pool.transfer(recipient, stroops));
  }

  /** Shielded → public XLM, back on this session account (then `sweepToWallet()` returns it to the smart account). */
  async unshield(stroops: bigint): Promise<SppExecuteResult> {
    return asExecuteResult(await this.pool.withdraw(stroops, this.sessionAddress));
  }

  /** Stop any SDK-side background work holding the storage DB. */
  destroy(): void {
    try {
      this.client.stopBackgroundSync();
    } catch (error) {
      // Already torn down (or never started) — nothing to recover from here.
      console.warn("SPP client teardown:", errorMessage(error));
    }
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
 * task's gate run.
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
    active.onPhase = options?.onPhase;
    options?.onPhase?.(active.phase);
    return active.rail;
  }

  const previous = active;
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
  if (previous) {
    void previous.rail.then((rail) => rail.destroy()).catch(() => undefined);
  }
  return entry.rail;
}
