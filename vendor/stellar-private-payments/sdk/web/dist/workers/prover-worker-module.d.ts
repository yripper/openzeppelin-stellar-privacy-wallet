/* tslint:disable */
/* eslint-disable */

/**
 * Wallet session for one Stellar account. Construct via
 * [`super::Client::account`].
 */
export class Account {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Locally derived ASP membership blinding for this account.
     */
    aspSecret(): Promise<string>;
    /**
     * Derive the ASP membership tree leaf for this account's stored keys.
     *
     * For explicit inputs without a session, use the free
     * [`derive_asp_user_leaf`](super::derive_asp_user_leaf) export.
     */
    deriveAspUserLeaf(): Promise<string>;
    /**
     * Whether this account's public keys are registered on-chain.
     */
    isRegistered(): Promise<boolean>;
    /**
     * Open a private pool session for this account.
     */
    pool(options: any): Promise<PrivatePool>;
    /**
     * Portfolio balances across all enabled pools in the deployment.
     */
    portfolio(): Promise<any>;
    /**
     * Register this account's public keys on the deployment-wide registry.
     */
    registerPublicKeys(options: any): Promise<string>;
    /**
     * Notes for this account across all pools (newest first).
     */
    userNotes(limit: number): Promise<any>;
    /**
     * Locally derived note and encryption public keys for this account.
     */
    userPublicKeys(): Promise<any>;
    readonly userAddress: string;
}

/**
 * Deployment-scoped browser SDK runtime: native [`NativeClient`] plus worker
 * handles.
 */
export class Client {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bind a wallet signer, derive privacy keys when missing, and return an
     * [`Account`] session.
     */
    account(options: any, signer: any): Promise<Account>;
    /**
     * On-chain state for all enabled pools plus shared ASP contracts.
     */
    allContractsData(): Promise<any>;
    /**
     * On-chain ASP membership and non-membership state.
     */
    aspState(): Promise<any>;
    /**
     * Start background contract-event sync into local storage.
     *
     * No-op if already started on this instance. After
     * [`Self::stop_background_sync`], call again to respawn. A fatal indexer
     * exit leaves the slot set — use a new [`Client`] to recover.
     */
    backgroundSync(): Promise<void>;
    /**
     * Bundled deployment config (contract addresses, pools, network).
     */
    static contractConfig(): any;
    /**
     * Build the client and spawn the prover worker
     */
    static new(rpc_url: string, storage: Storage, prover_worker_url: string, bootnode_url?: string | null): Promise<Client>;
    /**
     * Recent deployment activity (pool events, registry registrations, ASP
     * updates).
     */
    operationalFeed(limit: number): Promise<any>;
    /**
     * Look up a recipient's registered note and encryption public keys.
     */
    recipientLookup(address: string): Promise<any>;
    /**
     * Request the background indexer to exit (wakes its idle wait).
     *
     * Call before rebuilding this [`Client`] so a new instance does not race
     * the old loop on the same storage DB. Also runs from [`Drop`].
     */
    stopBackgroundSync(): void;
    /**
     * Catch local storage up to the current chain tip for the deployment.
     */
    sync(): Promise<void>;
    /**
     * Verify a selective-disclosure receipt without a wallet session.
     */
    verifySelectiveDisclosure(receipt_json: string, expected_vk_hash: string): Promise<any>;
}

/**
 * Per-pool session for deposits, transfers, and withdrawals.
 */
export class PrivatePool {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Balance in stroops (`bigint` in JS).
     */
    balance(): Promise<bigint>;
    /**
     * Deposit tokens. `amount` is stroops (`bigint` in JS).
     */
    deposit(amount: bigint): Promise<any>;
    /**
     * Generate a selective-disclosure proof for a note commitment.
     *
     * `config` matches [`DisclosureRequest`] (camelCase; `selectedCommitments`
     * array with 1..=4 entries). Returns `null` when the account must register
     * at the ASP before disclosing.
     */
    disclose(config: any): Promise<any>;
    /**
     * Estimate how many on-chain transactions a spend of `amount` stroops
     * would require.
     */
    estimate(amount: bigint): Promise<any>;
    /**
     * User notes for this pool (commitments, amounts, spent status).
     */
    notes(): Promise<any>;
    /**
     * Low-level pool `transact` call. See SDK [`Transact`] for field
     * semantics.
     */
    transact(config: any): Promise<any>;
    /**
     * Transfer privately. `recipient` is a Stellar `G...` address.
     */
    transfer(recipient: string, amount: bigint): Promise<any>;
    /**
     * Transfer privately to explicit recipient keys (note + encryption hex).
     */
    transferToKeys(note_public_key_hex: string, encryption_public_key_hex: string, amount: bigint): Promise<any>;
    verifyDisclosure(receipt: any, expected_vk_hash: string): Promise<any>;
    /**
     * Withdraw to `recipient`, or the connected wallet when omitted.
     */
    withdraw(amount: bigint, recipient?: string | null): Promise<any>;
}

/**
 * Worker-backed local persistence. Open once per page, [`fork`] for extra
 * handles.
 */
export class Storage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Raw storage-worker RPC. Request/response shapes match the worker
     * protocol (externally tagged enums, e.g. `{ "DisclaimerState": "G..."
     * }`).
     */
    call(request: any, timeout_ms?: number | null): Promise<any>;
    /**
     * New handle to the same storage worker (shared `spp.db`).
     */
    fork(): Storage;
    /**
     * Spawn the storage worker and verify it is ready.
     *
     * Call once per page session. Use [`Storage::fork`] for additional handles
     * (e.g. app code alongside [`crate::Client`]).
     */
    static open(options: any): Promise<Storage>;
}

/**
 * Probe whether the wallet RPC needs a historical-sync bootnode.
 *
 * Does not take or resolve a bootnode URL — callers supply that via
 * [`crate::Client::new`] after checking storage / prompting the user.
 */
export function bootnodeRequired(rpc_url: string, storage: Storage): Promise<boolean>;

/**
 * Configure the SDK telemetry settings (log level, sink targets, buffer sizes,
 * etc.).
 *
 * If telemetry has not been initialized yet, this function will initialize it
 * with the specified config (or defaults). If telemetry has already been
 * initialized, this will dynamically update runtime settings (log level and
 * sensitive log reveal).
 *
 * TS signature:
 * ```typescript
 * export function configureTelemetry(config?: {
 *   level?: string;
 *   sink?: "console" | "ringBuffer" | "both";
 *   ringBufferBytes?: number;
 *   revealSensitive?: boolean;
 * }): void;
 * ```
 */
export function configureTelemetry(config: any): void;

/**
 * Whether this build supports debug/trace logging and Tier-1 sensitive
 * reveal. Both are compiled out when `debug_assertions` is off (the
 * production `release` profile); the UI should hide or disable the
 * corresponding settings in that case.
 */
export function debugLogsEnabled(): boolean;

/**
 * Derive the ASP membership tree leaf from explicit public inputs.
 */
export function deriveAspUserLeaf(note_public_key: string, membership_blinding: string): string;

/**
 * Return recent formatted log output aggregated from the in-memory ring
 * buffers of the main thread and the storage/prover worker isolates.
 */
export function dump_recent_logs(): Promise<string>;

/**
 * Replace the active log level filter with `level`.
 *
 * `level` must be a bare level name such as `"info"`, `"debug"`, or
 * `"trace"` (target directives like `"crate=debug"` are not supported).
 */
export function set_log_level(level: string): void;

/**
 * Verify a selective-disclosure receipt with no wallet, no local storage,
 * and no [`Client`] instance — just an RPC URL. Skips the OPFS/SQLite
 * storage worker entirely, since verification never reads local state.
 */
export function verifySelectiveDisclosure(rpc_url: string, receipt_json: string, expected_vk_hash: string, options: any): Promise<any>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly rust_sqlite_wasm_abort: () => void;
    readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_malloc: (a: number) => number;
    readonly rust_sqlite_wasm_free: (a: number) => void;
    readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_localtime: (a: number) => number;
    readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
    readonly sqlite3_os_end: () => number;
    readonly sqlite3_os_init: () => number;
    readonly __wbg_account_free: (a: number, b: number) => void;
    readonly __wbg_client_free: (a: number, b: number) => void;
    readonly __wbg_privatepool_free: (a: number, b: number) => void;
    readonly __wbg_storage_free: (a: number, b: number) => void;
    readonly account_aspSecret: (a: number) => number;
    readonly account_deriveAspUserLeaf: (a: number) => number;
    readonly account_isRegistered: (a: number) => number;
    readonly account_pool: (a: number, b: number) => number;
    readonly account_portfolio: (a: number) => number;
    readonly account_registerPublicKeys: (a: number, b: number) => number;
    readonly account_userAddress: (a: number, b: number) => void;
    readonly account_userNotes: (a: number, b: number) => number;
    readonly account_userPublicKeys: (a: number) => number;
    readonly bootnodeRequired: (a: number, b: number, c: number) => number;
    readonly client_account: (a: number, b: number, c: number) => number;
    readonly client_allContractsData: (a: number) => number;
    readonly client_aspState: (a: number) => number;
    readonly client_backgroundSync: (a: number) => number;
    readonly client_contractConfig: (a: number) => void;
    readonly client_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly client_operationalFeed: (a: number, b: number) => number;
    readonly client_recipientLookup: (a: number, b: number, c: number) => number;
    readonly client_stopBackgroundSync: (a: number) => void;
    readonly client_sync: (a: number) => number;
    readonly client_verifySelectiveDisclosure: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly configureTelemetry: (a: number, b: number) => void;
    readonly debugLogsEnabled: () => number;
    readonly deriveAspUserLeaf: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly dump_recent_logs: () => number;
    readonly privatepool_balance: (a: number) => number;
    readonly privatepool_deposit: (a: number, b: bigint, c: bigint) => number;
    readonly privatepool_disclose: (a: number, b: number) => number;
    readonly privatepool_estimate: (a: number, b: bigint, c: bigint) => number;
    readonly privatepool_notes: (a: number) => number;
    readonly privatepool_transact: (a: number, b: number) => number;
    readonly privatepool_transfer: (a: number, b: number, c: number, d: bigint, e: bigint) => number;
    readonly privatepool_transferToKeys: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: bigint) => number;
    readonly privatepool_verifyDisclosure: (a: number, b: number, c: number, d: number) => number;
    readonly privatepool_withdraw: (a: number, b: bigint, c: bigint, d: number, e: number) => number;
    readonly set_log_level: (a: number, b: number, c: number) => void;
    readonly storage_call: (a: number, b: number, c: number) => number;
    readonly storage_fork: (a: number) => number;
    readonly storage_open: (a: number) => number;
    readonly verifySelectiveDisclosure: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly __wbg_trap_free: (a: number, b: number) => void;
    readonly main: (a: number, b: number) => number;
    readonly trap___wbg_wasmer_trap: () => void;
    readonly __wasm_bindgen_func_elem_1465: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1526: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_5201: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_1256: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: WebAssembly.Table;
    readonly __wbindgen_export4: (a: number) => void;
    readonly __wbindgen_export5: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export6: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
