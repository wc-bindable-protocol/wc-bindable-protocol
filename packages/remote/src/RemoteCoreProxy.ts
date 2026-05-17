import type { WcBindableDeclaration } from "@wc-bindable/core";
import type {
  ClientMessage,
  ClientTransport,
  DeclarationFingerprint,
  ServerMessage,
  RemoteRequestOptions,
  RemoteSerializedError,
} from "./types.js";
import { isReservedRemoteName } from "./transport/messageValidation.js";
import { type Logger, resolveLogger } from "./logger.js";
import {
  buildDeclarationFingerprint,
  declarationFingerprintsEqual,
} from "./declarationFingerprint.js";

const DEFAULT_PENDING_TIMEOUT_MS = 30_000;

/**
 * MUST-level default per SPEC-extensions.md § Pre-sync call state machine
 * → "Pre-sync queue depth bound (MUST)". Bounds the producer-controlled
 * latency surface: an unresponsive producer that never sends `sync` cannot
 * grow this queue without limit. Configurable via `maxPreSyncQueue`.
 */
const DEFAULT_MAX_PRE_SYNC_QUEUE = 1_024;

export interface RemoteCoreProxyOptions {
  /**
   * Soft cap on pending acknowledged requests (`setWithAck` + `invoke`).
   * When a new call would push the pending map past this count, it rejects
   * synchronously with a bounded-capacity error instead of letting the queue
   * grow under network stalls. Defaults to `Infinity` to preserve prior
   * behavior; set this in production to bound memory on untrusted or slow
   * peers.
   */
  maxPendingInvocations?: number;
  /**
   * Upper bound on the pre-sync queue depth — the count of `setWithAck` /
   * `setWithAckOptions` / `invoke` / `invokeWithOptions` calls waiting for
   * the first `sync` response (see SPEC-extensions.md § Pre-sync call state
   * machine). When a new call would push the queue past this count, it
   * rejects with an `error.code === "WC_BINDABLE_PRE_SYNC_QUEUE_FULL"`
   * error and the in-queue entries are NOT evicted. Defaults to
   * `DEFAULT_MAX_PRE_SYNC_QUEUE` (1 024). MUST be a positive integer if
   * provided. Only used when `preSyncBehavior` is `"queue"` (default).
   */
  maxPreSyncQueue?: number;
  /**
   * **Conformance switch — pre-sync `setWithAck` / `invoke` behavior.**
   *
   * - `"eager"` (default in 0.7.x for backward compatibility; **NON-conformant**
   *   per SPEC-extensions.md § Pre-sync call state machine MUST): calls
   *   are dispatched immediately, before the `setAck` capability is known.
   *   A `setWithAck` against a producer that ends up advertising
   *   `setAck: false` rejects with `WC_BINDABLE_SET_ACK_UNSUPPORTED` when
   *   the sync response arrives (`_rejectUnsupportedSetAckPending`).
   *   This is the legacy 0.6.x behavior — it is documented as a known
   *   conformance divergence (see [packages/remote/README.md § Known
   *   conformance divergences] and [CONFORMANCE.md vector 17 / vector 38]).
   * - `"queue"` (opt-in conformant behavior; **planned default in 0.8.0**):
   *   the same calls are queued onto `_preSyncQueue` and replayed in
   *   caller order after the first `sync` response arrives. `setWithAck`
   *   against a `setAck: false` producer rejects locally without ever
   *   reaching the wire. Recommended for new code that wants the spec
   *   contract today.
   *
   * The default flips to `"queue"` in 0.8.0; this option will be removed
   * in 1.0. Document the choice in any public API surface that wraps
   * `createRemoteCoreProxy`.
   */
  preSyncBehavior?: "queue" | "eager";
  /**
   * Logger used for diagnostic output (ignored-sync-value warnings,
   * unknown-response warnings, etc.). Defaults to `console.warn` /
   * `console.error`. Inject a structured logger in production.
   */
  logger?: Logger;
}

function normalizePendingLimit(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(
      "RemoteCoreProxy: maxPendingInvocations must be a positive integer or omitted",
    );
  }
  return value;
}

function normalizePreSyncQueueLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PRE_SYNC_QUEUE;
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(
      "RemoteCoreProxy: maxPreSyncQueue must be a positive integer or omitted",
    );
  }
  return value;
}

function createAbortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  if (typeof DOMException !== "undefined") {
    return new DOMException("This operation was aborted", "AbortError");
  }
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function createTimeoutError(operation: string, timeoutMs: number): Error {
  const error = new Error(`RemoteCoreProxy: ${operation} timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

/**
 * Build an Error with a machine-readable `code` field set to one of the
 * normatively-registered values in SPEC-extensions.md § Error envelope.
 * Consumer recovery branches MUST pattern-match on `code`, not on `message`.
 */
function createCodedError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function normalizeTimeoutMs(options?: RemoteRequestOptions): number | null {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs === undefined) {
    return DEFAULT_PENDING_TIMEOUT_MS;
  }
  if (timeoutMs === 0) {
    return null;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      "RemoteCoreProxy: timeoutMs must be a non-negative finite number; use 0 to disable the timeout",
    );
  }
  return timeoutMs;
}

function canSerializeClientMessage(message: ClientMessage): boolean {
  try {
    JSON.stringify(message);
    return true;
  } catch {
    return false;
  }
}

function createCommandId(getFallbackId: () => number): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return String(getFallbackId());
}

function isRemoteSerializedError(value: unknown): value is RemoteSerializedError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.message === "string" &&
    (candidate.stack === undefined || typeof candidate.stack === "string")
  );
}

/**
 * One queued pre-sync call. The proxy uses this between transport attach
 * and the first received `sync` response so that `setWithAck` / `invoke`
 * never reach the wire before the `setAck` capability is known and the
 * fingerprint has been compared. See SPEC-extensions.md § Pre-sync call
 * state machine.
 */
type PreSyncQueueEntry = {
  kind: "set-ack" | "invoke";
  name: string;
  /** Present for `set-ack` entries. */
  value?: unknown;
  /** Present for `invoke` entries. */
  args?: unknown[];
  options: RemoteRequestOptions | undefined;
  timeoutContext: string;
  /** Forwards the post-drain dispatch (or pre-drain rejection) to the
   *  caller's awaited Promise. */
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** Tears down per-entry abort / timeout listeners and removes the entry
   *  from `_preSyncQueue` if still present. Idempotent. */
  cleanup: () => void;
};

function reviveThrownError(value: unknown): unknown {
  if (!isRemoteSerializedError(value)) {
    return value;
  }

  const error = new Error(value.message) as Error & { cause?: unknown };
  error.name = value.name;

  if (typeof value.stack === "string") {
    error.stack = value.stack;
  }

  try {
    Object.defineProperty(error, "cause", {
      value,
      configurable: true,
      writable: true,
    });
  } catch {
    error.cause = value;
  }

  return error;
}

/**
 * Client-side proxy that represents a remote Core.
 *
 * It extends EventTarget so that `bind()` from @wc-bindable/core works
 * transparently. Input property setters and command invocations are
 * forwarded to the server via the provided transport.
 *
 * Use `createRemoteCoreProxy()` to create instances — it ensures each
 * proxy has an isolated `constructor.wcBindable` so that multiple proxies
 * with different declarations can coexist on the same page.
 */
export class RemoteCoreProxy extends EventTarget {
  private _transport: ClientTransport | null = null;
  private _eventsByName: Map<string, string>;
  private _inputs: Set<string>;
  private _commands: Set<string>;
  private _values: Record<string, unknown> = {};
  private _pending: Map<string, {
    kind: "set-ack" | "invoke";
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    cleanup: () => void;
  }> = new Map();
  private _cmdId = 0;
  private _connectionError: Error | null = null;
  private _disposedError: Error | null = null;
  private _transportGeneration = 0;
  private _setAckSupported: boolean | null = null;
  private _maxPendingInvocations: number;
  private _maxPreSyncQueue: number;
  /**
   * When `"eager"`, pre-sync `setWithAck` / `invoke` skip the queue and
   * dispatch immediately (0.6.x legacy behavior). When `"queue"` (default),
   * they queue per SPEC-extensions.md § Pre-sync call state machine MUST.
   */
  private _preSyncBehavior: "queue" | "eager";
  private _logger: Logger;
  /**
   * True between transport attach and the first received `sync` response on
   * that transport. Reset to true on every reconnect. While true,
   * `setWithAck` / `setWithAckOptions` / `invoke` / `invokeWithOptions`
   * queue onto `_preSyncQueue` instead of issuing wire traffic
   * immediately, per the MUST in SPEC-extensions.md § Pre-sync call state
   * machine.
   */
  private _isPreSync = false;
  /**
   * FIFO queue of pre-sync `setWithAck` / `invoke` calls waiting for the
   * first `sync` response. Drained in caller order when the response
   * arrives (and replayed with the appropriate disposition per setAck
   * capability). Drained-and-rejected on terminal failure before sync.
   */
  private _preSyncQueue: PreSyncQueueEntry[] = [];
  /** Local fingerprint, computed once at construction and compared against
   *  the server's fingerprint on every `sync` response. See
   *  SPEC-extensions.md § Declaration fingerprint. */
  private _localFingerprint: DeclarationFingerprint;
  /** True once we have warned about a fingerprint mismatch on this
   *  transport; prevents per-resync log spam. Reset on reconnect. */
  private _fingerprintMismatchWarned = false;

  constructor(
    declaration: WcBindableDeclaration,
    transport: ClientTransport,
    options: RemoteCoreProxyOptions = {},
  ) {
    super();
    this._eventsByName = new Map(declaration.properties.map((prop) => [prop.name, prop.event]));
    this._inputs = new Set((declaration.inputs ?? []).map((input) => input.name));
    this._commands = new Set((declaration.commands ?? []).map((command) => command.name));
    this._maxPendingInvocations = normalizePendingLimit(options.maxPendingInvocations);
    this._maxPreSyncQueue = normalizePreSyncQueueLimit(options.maxPreSyncQueue);
    // Default is "eager" in 0.7.x for backward compatibility with the 0.6.x
    // optimistic-send behavior; the planned 0.8.0 release flips this to
    // "queue" to match the SPEC-extensions.md § Pre-sync call state machine MUST.
    // Document this choice explicitly in any wrapper API.
    this._preSyncBehavior = options.preSyncBehavior ?? "eager";
    this._logger = resolveLogger(options.logger);
    this._localFingerprint = buildDeclarationFingerprint(declaration);

    this._attachTransport(transport);
  }

  /** Set an input property on the remote Core. */
  set(name: string, value: unknown): void {
    this._validateInputName(name);
    const transport = this._requireTransport();
    try {
      transport.send({ type: "set", name, value });
    } catch (err) {
      throw this._handleSendFailure(transport, err);
    }
  }

  /** Set an input property and wait for the server to acknowledge or reject it. */
  setWithAck(name: string, value: unknown): Promise<void> {
    return this.setWithAckOptions(name, value, {});
  }

  /** Set an input property and wait for the server reply with lifecycle options such as AbortSignal. */
  setWithAckOptions(name: string, value: unknown, options: RemoteRequestOptions): Promise<void> {
    try {
      this._validateInputName(name);
    } catch (err) {
      return Promise.reject(err);
    }
    if (this._disposedError) {
      return Promise.reject(this._disposedError);
    }
    // setAck capability is known only after the first `sync` response.
    // Per SPEC-extensions.md § Pre-sync call state machine MUST, pre-sync
    // `setWithAck` MUST queue instead of fast-rejecting on a capability we
    // have not learned yet — the conformant behavior is gated behind
    // `preSyncBehavior: "queue"` (the planned 0.8.0 default). The 0.7.x
    // default `"eager"` preserves the legacy optimistic-send behavior.
    if (this._isPreSync && this._preSyncBehavior === "queue") {
      return this._enqueuePreSync<void>("set-ack", name, value, undefined, options, `setWithAck("${name}")`);
    }
    if (this._setAckSupported === false) {
      return Promise.reject(createCodedError(
        "WC_BINDABLE_SET_ACK_UNSUPPORTED",
        "RemoteCoreProxy: remote server does not support setWithAck(); use set() or upgrade the server",
      ));
    }

    const transport = this._transport;
    if (!transport) {
      /* v8 ignore next -- reaching transport=null without a recorded connection error requires mutating private state */
      return Promise.reject(this._connectionError ?? new Error("Transport closed"));
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }

    return this._createPendingRequest<void>(
      "set-ack",
      options,
      `setWithAck(\"${name}\")`,
      (id) => {
        const message: ClientMessage = { type: "set", name, value, id };
        try {
          transport.send(message);
        } catch (err) {
          if (!canSerializeClientMessage(message)) {
            this._rejectPendingRequest(id, err);
            return;
          }
          // _handleSendFailure rejects all pending (including this id) and
          // clears the transport so reconnect() can attach a new one.
          this._handleSendFailure(transport, err);
        }
      },
    );
  }

  /** Invoke a command on the remote Core and return its result. */
  invoke(name: string, ...args: unknown[]): Promise<unknown> {
    return this._invoke(name, args);
  }

  /** Invoke a command on the remote Core with explicit wire arguments and lifecycle options. */
  invokeWithOptions(name: string, args: unknown[], options?: RemoteRequestOptions): Promise<unknown>;

  /**
   * @deprecated Scheduled for removal in v1.0. Use the explicit form
   * `invokeWithOptions(name, args, options)` instead.
   *
   * This legacy `invokeWithOptions(name, options, ...args)` overload is kept
   * only so existing 0.x callers do not break. It cannot disambiguate a first
   * wire argument that is itself an array — the runtime branches on
   * `Array.isArray(optionsOrArgs)`, so `invokeWithOptions("save", [1, 2, 3])`
   * is always interpreted as `args = [1, 2, 3]`, never as
   * `options = [1, 2, 3]`. New code must use the explicit form.
   *
   * Migration: pass wire args as a single array and options as the last
   * argument, e.g. `invokeWithOptions("save", [[1, 2, 3]], { timeoutMs: 0 })`.
   */
  invokeWithOptions(name: string, options: RemoteRequestOptions, ...args: unknown[]): Promise<unknown>;

  invokeWithOptions(
    name: string,
    optionsOrArgs: RemoteRequestOptions | unknown[],
    ...argsOrOptions: unknown[]
  ): Promise<unknown> {
    if (Array.isArray(optionsOrArgs)) {
      return this._invoke(name, optionsOrArgs, argsOrOptions[0] as RemoteRequestOptions | undefined);
    }

    return this._invoke(name, argsOrOptions, optionsOrArgs);
  }

  private _invoke(name: string, args: unknown[], options?: RemoteRequestOptions): Promise<unknown> {
    if (!this._commands.has(name)) {
      return Promise.reject(
        new Error(`RemoteCoreProxy: command "${name}" is not declared in wcBindable.commands`),
      );
    }
    if (this._disposedError) {
      return Promise.reject(this._disposedError);
    }
    // Per SPEC-extensions.md § Pre-sync call state machine MUST, pre-sync
    // `invoke` MUST queue alongside `setWithAck` so caller-order FIFO is
    // preserved across mixed traffic. Gated behind `preSyncBehavior: "queue"`
    // (planned 0.8.0 default); 0.7.x defaults to `"eager"` legacy behavior.
    if (this._isPreSync && this._preSyncBehavior === "queue") {
      return this._enqueuePreSync<unknown>("invoke", name, undefined, args, options, `invoke("${name}")`);
    }
    const transport = this._transport;
    if (!transport) {
      return Promise.reject(this._connectionError ?? new Error("Transport closed"));
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }

    return this._createPendingRequest<unknown>(
      "invoke",
      options,
      `invoke(\"${name}\")`,
      (id) => {
        const message: ClientMessage = { type: "cmd", name, id, args };
        try {
          transport.send(message);
        } catch (err) {
          if (!canSerializeClientMessage(message)) {
            this._rejectPendingRequest(id, err);
            return;
          }
          // _handleSendFailure rejects all pending (including this id) and
          // clears the transport so reconnect() can attach a new one.
          this._handleSendFailure(transport, err);
        }
      },
    );
  }

  private _createPendingRequest<T>(
    kind: "set-ack" | "invoke",
    options: RemoteRequestOptions | undefined,
    timeoutContext: string,
    dispatch: (id: string) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Normalize inside the executor so invalid timeoutMs surfaces as an
      // async rejection, matching the rest of this promise-returning API
      // (aborted/disposed/transport-closed all reject, never throw).
      let timeoutMs: number | null;
      try {
        timeoutMs = normalizeTimeoutMs(options);
      } catch (err) {
        reject(err);
        return;
      }
      if (this._pending.size >= this._maxPendingInvocations) {
        reject(new Error(
          `RemoteCoreProxy: pending invocations exceeded maxPendingInvocations=${this._maxPendingInvocations}`,
        ));
        return;
      }
      const signal = options?.signal;
      const id = createCommandId(() => ++this._cmdId);
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
      };
      const onAbort = () => {
        const pending = this._pending.get(id);
        /* v8 ignore next -- cleanup removes the listener before pending can disappear */
        if (!pending) return;
        this._pending.delete(id);
        pending.cleanup();
        pending.reject(createAbortError(signal!));
      };
      const onTimeout = () => {
        const pending = this._pending.get(id);
        /* v8 ignore next -- timeout is cleared when pending settles before it can fire */
        if (!pending) return;
        this._pending.delete(id);
        pending.cleanup();
        pending.reject(createTimeoutError(timeoutContext, timeoutMs!));
      };

      // The pending map is type-erased (resolve: (v: unknown) => void) so
      // set-ack (T = void) and invoke (T = unknown) can share one table.
      // Wrap to bridge the generic resolve back into the erased slot.
      this._pending.set(id, {
        kind,
        resolve: (v) => resolve(v as T),
        reject,
        cleanup,
      });

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (timeoutMs !== null) {
        timeoutHandle = setTimeout(onTimeout, timeoutMs);
      }

      dispatch(id);
    });
  }

  /**
   * Queue a pre-sync `setWithAck` / `invoke` call. The promise stays
   * pending until the first `sync` response arrives and `_drainPreSyncQueue`
   * either dispatches the wire message or rejects with
   * `WC_BINDABLE_SET_ACK_UNSUPPORTED`. Per-entry abort / timeout listeners
   * are installed while queued so the call settles even if `sync` never
   * arrives.
   *
   * Bounded by `_maxPreSyncQueue`: when the queue is at capacity, the new
   * call rejects with `WC_BINDABLE_PRE_SYNC_QUEUE_FULL` (the in-queue
   * entries MUST NOT be evicted, per SPEC-extensions.md § Pre-sync call
   * state machine → "Pre-sync queue depth bound (MUST)").
   */
  private _enqueuePreSync<T>(
    kind: "set-ack" | "invoke",
    name: string,
    value: unknown | undefined,
    args: unknown[] | undefined,
    options: RemoteRequestOptions | undefined,
    timeoutContext: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this._preSyncQueue.length >= this._maxPreSyncQueue) {
        reject(createCodedError(
          "WC_BINDABLE_PRE_SYNC_QUEUE_FULL",
          `RemoteCoreProxy: pre-sync queue exceeded maxPreSyncQueue=${this._maxPreSyncQueue}; ` +
            "the in-queue entries are preserved per SPEC-extensions.md MUST. " +
            "Either wait for the sync response to drain the queue, raise maxPreSyncQueue " +
            "on createRemoteCoreProxy(), or stop optimistic-bursting before the handshake.",
        ));
        return;
      }
      // Validate timeoutMs at the call site so an invalid value surfaces as
      // an async rejection rather than being silently held until drain.
      let timeoutMs: number | null;
      try {
        timeoutMs = normalizeTimeoutMs(options);
      } catch (err) {
        reject(err);
        return;
      }
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(createAbortError(signal));
        return;
      }

      let entry: PreSyncQueueEntry;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        const idx = this._preSyncQueue.indexOf(entry);
        if (idx >= 0) this._preSyncQueue.splice(idx, 1);
      };
      const onAbort = () => {
        cleanup();
        /* v8 ignore next -- abort handler only fires while still queued; signal is non-null on this code path */
        reject(createAbortError(signal!));
      };
      const onTimeout = () => {
        cleanup();
        reject(createTimeoutError(timeoutContext, timeoutMs!));
      };

      entry = {
        kind,
        name,
        value,
        args,
        options,
        timeoutContext,
        resolve: resolve as (v: unknown) => void,
        reject,
        cleanup,
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (timeoutMs !== null) {
        timeoutHandle = setTimeout(onTimeout, timeoutMs);
      }

      this._preSyncQueue.push(entry);
    });
  }

  /**
   * Replay the pre-sync queue in caller order once the first `sync`
   * response has been received and processed. For each entry:
   *
   * - `set-ack` against a producer that did NOT advertise `capabilities.setAck`
   *   rejects with `WC_BINDABLE_SET_ACK_UNSUPPORTED`; no wire message is sent.
   * - `set-ack` against a `setAck: true` producer is dispatched as an
   *   id-bearing `set` and the entry's promise resolves on the matching
   *   `return` / rejects on `throw`, timeout, abort, or transport
   *   terminal — same lifecycle as a post-sync `setWithAck`.
   * - `invoke` is dispatched as a `cmd` regardless of `setAck` (its
   *   semantics do not depend on the capability).
   *
   * Per-caller FIFO is preserved across mixed `set-ack` + `invoke` traffic.
   * After this method returns the proxy is in steady-state and new calls
   * skip the queue path entirely.
   */
  private _drainPreSyncQueue(): void {
    const queue = this._preSyncQueue;
    this._preSyncQueue = [];
    this._isPreSync = false;
    const setAckSupported = this._setAckSupported === true;
    for (const entry of queue) {
      // Tear down the pre-sync abort / timeout listeners — `_createPendingRequest`
      // will install its own for the post-drain pending entry.
      entry.cleanup();
      if (entry.kind === "set-ack" && !setAckSupported) {
        entry.reject(createCodedError(
          "WC_BINDABLE_SET_ACK_UNSUPPORTED",
          "RemoteCoreProxy: remote server does not support setWithAck(); use set() or upgrade the server",
        ));
        continue;
      }
      this._dispatchDrainedEntry(entry);
    }
  }

  /**
   * Allocate a pending-table id for a queue entry that has cleared the
   * sync-time admission rules, send the wire message, and forward its
   * settlement to the entry's original `resolve` / `reject`.
   */
  private _dispatchDrainedEntry(entry: PreSyncQueueEntry): void {
    const transport = this._transport;
    if (!transport) {
      // Transport torn down between sync arrival and drain — defensive
      // fallback. The standard terminal paths drain the queue with the
      // terminal error before this branch can fire under normal flow.
      /* v8 ignore next 2 */
      entry.reject(this._connectionError ?? this._disposedError ?? new Error("Transport closed"));
      return;
    }
    const dispatcher = (id: string) => {
      const message: ClientMessage = entry.kind === "set-ack"
        ? { type: "set", name: entry.name, value: entry.value, id }
        : { type: "cmd", name: entry.name, id, args: entry.args ?? [] };
      try {
        transport.send(message);
      } catch (err) {
        if (!canSerializeClientMessage(message)) {
          this._rejectPendingRequest(id, err);
          return;
        }
        this._handleSendFailure(transport, err);
      }
    };
    const pending = this._createPendingRequest<unknown>(
      entry.kind,
      entry.options,
      entry.timeoutContext,
      dispatcher,
    );
    pending.then(entry.resolve, entry.reject);
  }

  /**
   * Drain the pre-sync queue with a terminal error — called from every
   * terminal / close path so a queued `setWithAck` / `invoke` whose drain
   * will never run does not leak its caller's awaited Promise.
   */
  private _rejectPreSyncQueue(error: Error): void {
    if (this._preSyncQueue.length === 0) {
      this._isPreSync = false;
      return;
    }
    const queue = this._preSyncQueue;
    this._preSyncQueue = [];
    this._isPreSync = false;
    for (const entry of queue) {
      entry.cleanup();
      entry.reject(error);
    }
  }

  /** Attach a new transport after the previous one closed. Existing subscribers remain active. */
  reconnect(transport: ClientTransport): void {
    if (this._disposedError) {
      throw this._disposedError;
    }
    if (this._transport && !this._connectionError) {
      throw new Error("RemoteCoreProxy: transport is already connected");
    }

    this._attachTransport(transport);
  }

  /** Reject pending work and stop processing future transport events. */
  dispose(): void {
    if (this._disposedError) return;
    const error = createCodedError("WC_BINDABLE_DISPOSED", "RemoteCoreProxy disposed");
    const transport = this._transport;
    this._disposedError = error;
    this._connectionError = error;
    this._transport = null;
    this._transportGeneration++;
    this._rejectPending(error);
    // Drain any pre-sync queue with the same coded error so callers
    // awaiting a queued setWithAck/invoke get a deterministic rejection
    // instead of a hung Promise.
    this._rejectPreSyncQueue(error);
    this._disposeTransport(transport);
  }

  private _handleClose(): void {
    /* v8 ignore next -- late close callbacks after dispose are intentionally ignored */
    if (this._disposedError) return;
    const transport = this._transport;
    this._connectionError = createCodedError(
      "WC_BINDABLE_TERMINAL_FAILURE",
      "Transport closed",
    );
    this._transport = null;
    this._transportGeneration++;
    this._rejectPending(this._connectionError);
    this._rejectPreSyncQueue(this._connectionError);
    this._disposeTransport(transport);
  }

  /**
   * Treat a thrown send() as a transport-level failure: clear the active
    * transport, reject pending work, and dispose only the failed transport.
    * The proxy itself remains reconnectable: it transitions into the same
    * disconnected state used by onClose rather than the terminal disposed
    * state. Without this, a transport that signals closure only by throwing
    * from send (and does not implement the optional onClose) would leave the
    * proxy permanently stuck — reconnect() would refuse because _transport is
    * still set.
   *
   * Returns the normalized Error so callers can throw it synchronously.
   * Safe to call when the proxy has already been disposed or when another
   * transport has since been attached — in both cases this is a no-op.
   */
  private _handleSendFailure(transport: ClientTransport, err: unknown): Error {
    /* v8 ignore start -- these defensive branches require malformed runtime throws or stale private-state races */
    const error = err instanceof Error ? err : new Error(String(err));
    if (this._disposedError) return this._disposedError;
    if (this._transport !== transport) return error;
    /* v8 ignore stop */
    this._connectionError = error;
    this._transport = null;
    this._transportGeneration++;
    this._rejectPending(error);
    this._rejectPreSyncQueue(error);
    this._disposeTransport(transport);
    return error;
  }

  private _rejectPending(error: Error): void {
    for (const [, pending] of this._pending) {
      pending.cleanup();
      pending.reject(error);
    }
    this._pending.clear();
  }

  private _rejectPendingRequest(id: string, error: unknown): void {
    const pending = this._pending.get(id);
    /* v8 ignore next -- private helper may be called redundantly during send-failure cleanup */
    if (!pending) return;
    this._pending.delete(id);
    pending.cleanup();
    pending.reject(error);
  }

  private _validateInputName(name: string): void {
    // Validate the input name before checking transport state so that typos
    // surface as a declaration error even when the proxy is disconnected or
    // disposed — otherwise diagnosing client-side bugs on a stale proxy is
    // harder (see README "Error handling").
    if (!this._inputs.has(name)) {
      throw new Error(`RemoteCoreProxy: input "${name}" is not declared in wcBindable.inputs`);
    }
  }

  private _requireTransport(): ClientTransport {
    if (this._disposedError) {
      throw this._disposedError;
    }
    if (!this._transport) {
      /* v8 ignore next -- reaching transport=null without a recorded connection error requires mutating private state */
      throw this._connectionError ?? new Error("Transport closed");
    }
    return this._transport;
  }

  private _disposeTransport(transport: ClientTransport | null): void {
    /* v8 ignore next -- dispose() is optional on the transport contract */
    if (!transport?.dispose) return;
    transport.dispose();
  }

  /**
   * Compare the producer's declaration fingerprint to the local one.
   *
   * Returns `true` when the consumer MUST treat the sync response as
   * terminal and stop processing it (the `protocol` axis differs — see
   * SPEC-extensions.md § Declaration fingerprint, "protocol differs"
   * bullet, and vector 35 in CONFORMANCE.md). Returns `false` for the
   * other cases: equal fingerprints, legacy fingerprint absent, legacy
   * fingerprint missing the `protocol` field, and non-`protocol`
   * mismatches (warn-and-continue per the same section).
   */
  private _compareDeclarationFingerprint(
    remote: DeclarationFingerprint | undefined,
  ): boolean {
    if (remote === undefined) return false;
    if (declarationFingerprintsEqual(remote, this._localFingerprint)) return false;
    const localProtocol = this._localFingerprint.protocol;
    const remoteProtocol = remote.protocol;
    if (
      typeof localProtocol === "string" &&
      typeof remoteProtocol === "string" &&
      localProtocol !== remoteProtocol
    ) {
      // `protocol` axis disagrees. This is a breaking-compatibility
      // boundary per SPEC.md § Versioning — continuing past it would let
      // a v1 consumer process v2-shaped envelopes (the silent-corruption
      // scenario SPEC-extensions.md § Wire format versioning item 4
      // exists to prevent). MUST terminal regardless of strict-mode opt-in.
      const triggerError = createCodedError(
        "WC_BINDABLE_PROTOCOL_ERROR",
        "RemoteCoreProxy: declaration protocol identifier mismatch between client and server " +
          `(local="${localProtocol}", remote="${remoteProtocol}"). Continuing past this would let ` +
          "the consumer silently process envelopes of a different wire-protocol version. " +
          "Update one side so both declarations advertise the same `protocol` identifier.",
      );
      this._terminate(triggerError);
      return true;
    }
    if (this._fingerprintMismatchWarned) return false;
    this._fingerprintMismatchWarned = true;
    this._logger.warn(
      "RemoteCoreProxy: declaration fingerprint mismatch between client and server. " +
        "The local declaration passed to createRemoteCoreProxy() does not match the " +
        "server-side wcBindable. Check that both sides are on the same package version. " +
        `Local=${JSON.stringify(this._localFingerprint)} Remote=${JSON.stringify(remote)}`,
    );
    return false;
  }

  /**
   * Tear the proxy down because a wire-protocol-level condition forces
   * TerminalFailure (currently: fingerprint `protocol` mismatch). Pending
   * entries reject in caller order with the supplied `triggerError`
   * (carrying the trigger code per SPEC-extensions.md § Error envelope —
   * e.g. `WC_BINDABLE_PROTOCOL_ERROR`); subsequent `set` / `setWithAck` /
   * `invoke` calls reject with a `WC_BINDABLE_TERMINAL_FAILURE`-coded
   * error, matching vector 34's terminal-path rule and vector 35's
   * three-way code split.
   *
   * Distinct from `dispose()` (which is consumer-initiated and emits
   * `WC_BINDABLE_DISPOSED`) and from `_handleSendFailure` (which is
   * transport-send-induced and currently leaves room for `reconnect()`
   * to recover). `reconnect()` MAY still recover from this terminal
   * state if the user attaches a transport whose producer advertises the
   * matching `protocol` identifier; the spec's TerminalFailure → PreSync
   * transition is preserved.
   */
  private _terminate(triggerError: Error): void {
    /* v8 ignore next -- dispose() has already torn everything down; nothing more to do */
    if (this._disposedError) return;
    const transport = this._transport;
    const terminalError = createCodedError(
      "WC_BINDABLE_TERMINAL_FAILURE",
      "RemoteCoreProxy: transport in terminal state",
    );
    this._connectionError = terminalError;
    this._transport = null;
    this._transportGeneration++;
    this._rejectPending(triggerError);
    this._rejectPreSyncQueue(triggerError);
    this._disposeTransport(transport);
  }

  private _rejectUnsupportedSetAckPending(): void {
    const error = new Error(
      "RemoteCoreProxy: remote server does not support setWithAck(); use set() or upgrade the server",
    );

    for (const [id, pending] of this._pending) {
      if (pending.kind !== "set-ack") continue;
      this._pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }

  private _attachTransport(transport: ClientTransport): void {
    const generation = ++this._transportGeneration;
    this._transport = transport;
    this._connectionError = null;
    this._setAckSupported = null;
    this._fingerprintMismatchWarned = false;
    // Fresh transport → fresh PreSync window. Any setWithAck / invoke
    // called between now and the first received `sync` response on this
    // transport will be queued onto `_preSyncQueue` (or rejected with
    // WC_BINDABLE_PRE_SYNC_QUEUE_FULL when the bound is reached).
    this._isPreSync = true;

    transport.onMessage((msg) => {
      /* v8 ignore next -- stale transport callbacks after reconnect are ignored defensively */
      if (generation !== this._transportGeneration) return;
      this._handleMessage(msg);
    });
    transport.onClose?.(() => {
      /* v8 ignore next -- stale transport callbacks after reconnect are ignored defensively */
      if (generation !== this._transportGeneration) return;
      this._handleClose();
    });

    try {
      transport.send({ type: "sync" });
    } catch (err) {
      throw this._handleSendFailure(transport, err);
    }
  }

  private _handleMessage(msg: ServerMessage): void {
    /* v8 ignore next -- late messages after dispose are intentionally ignored */
    if (this._disposedError) return;
    switch (msg.type) {
      case "sync": {
        // Compare the declaration fingerprint **before** any other sync
        // processing. A `protocol` axis disagreement is a breaking-
        // compatibility boundary (SPEC.md § Versioning) and the spec
        // requires pending entries to drain with the TRIGGER code
        // `WC_BINDABLE_PROTOCOL_ERROR` (CONFORMANCE.md vector 35). If we
        // ran the setAck-capability check first, pre-sync `setWithAck`
        // entries that landed in `_pending` under the legacy `"eager"`
        // path would already have rejected with
        // `WC_BINDABLE_SET_ACK_UNSUPPORTED` by the time `_terminate`
        // tried to drain them, masking the wire-protocol disagreement
        // with a capability-mismatch error. Protocol mismatch takes
        // precedence — capability and value processing are skipped
        // entirely on termination.
        if (this._compareDeclarationFingerprint(msg.declarationFingerprint)) {
          return;
        }
        this._setAckSupported = msg.capabilities?.setAck === true;
        if (!this._setAckSupported) {
          this._rejectUnsupportedSetAckPending();
        }
        const getterFailures = new Set(msg.getterFailures ?? []);
        const undefinedProperties = new Set(msg.undefinedProperties ?? []);
        // Populate cache and dispatch events for each initial value.
        for (const [name, value] of Object.entries(msg.values)) {
          const eventName = this._eventsByName.get(name);
          if (!eventName) {
            this._logger.warn(`RemoteCoreProxy: ignored sync value for undeclared property "${name}"`);
            continue;
          }

          this._values[name] = value;
          this.dispatchEvent(new CustomEvent(eventName, { detail: value }));
        }
        // Emit explicit `undefined` events for properties the server marked
        // as currently undefined. Doing this unconditionally (rather than
        // only "when the cache was non-undefined") lets bind() subscribers
        // observe the initial undefined value on the very first sync, which
        // the omitted-key convention alone cannot disambiguate.
        for (const name of undefinedProperties) {
          const eventName = this._eventsByName.get(name);
          if (!eventName) {
            this._logger.warn(`RemoteCoreProxy: ignored sync undefinedProperties entry for undeclared property "${name}"`);
            continue;
          }
          if (this._values[name] === undefined && Object.prototype.hasOwnProperty.call(this._values, name)) {
            // Already cached as undefined and the client has already seen
            // an event for it; skip to avoid redundant dispatch.
            continue;
          }
          this._values[name] = undefined;
          this.dispatchEvent(new CustomEvent(eventName, { detail: undefined }));
        }
        // Fallback ONLY for legacy servers that do not advertise the
        // `undefinedProperties` capability. A modern producer that
        // advertises the capability and sends `undefinedProperties: []`
        // is explicitly stating "no undefined values right now"; reverting
        // every omitted-but-cached property to undefined in that case
        // would be a spurious state change. The capability bit (not just
        // the field's presence) is the disambiguator — modern producers
        // MAY omit the empty array even with the capability set.
        const supportsUndefinedProperties = msg.capabilities?.undefinedProperties === true;
        if (!supportsUndefinedProperties) {
          for (const name of this._eventsByName.keys()) {
            if (Object.prototype.hasOwnProperty.call(msg.values, name)) continue;
            /* v8 ignore next -- getterFailures only appears when an omitted property failed during sync */
            if (getterFailures.has(name)) continue;
            if (undefinedProperties.has(name)) continue;
            if (this._values[name] === undefined) continue;
            this._values[name] = undefined;
            const eventName = this._eventsByName.get(name)!;
            this.dispatchEvent(new CustomEvent(eventName, { detail: undefined }));
          }
        }
        // Replay any pre-sync queued setWithAck / invoke in caller order
        // AFTER initial-sync events have dispatched. Doing this here (as
        // opposed to before value processing) preserves the spec's
        // ordering invariant: callers see initial-sync `onUpdate`
        // callbacks before any post-handshake `set` / `invoke` settles.
        this._drainPreSyncQueue();
        break;
      }
      case "update": {
        // Update local cache by property name, then dispatch a per-property
        // event so local bind() picks it up. The proxy uses synthetic event
        // names (see createRemoteCoreProxy) to avoid collisions when multiple
        // properties share an event name on the Core side.
        const eventName = this._eventsByName.get(msg.name);
        if (!eventName) {
          this._logger.warn(`RemoteCoreProxy: ignored update for undeclared property "${msg.name}"`);
          break;
        }

        this._values[msg.name] = msg.value;
        this.dispatchEvent(new CustomEvent(eventName, { detail: msg.value }));
        break;
      }
      case "return": {
        const pending = this._pending.get(msg.id);
        if (pending) {
          if (pending.kind === "set-ack" && msg.value !== undefined) {
            this._logger.warn(
              `RemoteCoreProxy: received return payload for setWithAck request id "${msg.id}"; ignoring unexpected value`,
            );
          }
          this._pending.delete(msg.id);
          pending.cleanup();
          pending.resolve(pending.kind === "set-ack" ? undefined : msg.value);
        } else {
          this._logger.warn(`RemoteCoreProxy: received return for unknown request id "${msg.id}"`);
        }
        break;
      }
      case "throw": {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          pending.cleanup();
          pending.reject(reviveThrownError(msg.error));
        } else {
          this._logger.warn(`RemoteCoreProxy: received throw for unknown request id "${msg.id}"`);
        }
        break;
      }
    }
  }

  _hasDeclaredProperty(name: string): boolean {
    return this._eventsByName.has(name);
  }

  _hasCachedValue(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._values, name);
  }

  _isDeclaredInput(name: string): boolean {
    return this._inputs.has(name);
  }

  _getCachedValue(name: string): unknown {
    return this._values[name];
  }
}

// Proxy handler for property access on cached values.
// Native EventTarget methods (addEventListener, dispatchEvent, etc.) must
// be bound to the real target, not the Proxy — browsers throw "Illegal
// invocation" when native methods are called with a Proxy as `this`.
const handler: ProxyHandler<RemoteCoreProxy> = {
  // Make `in` reflect what bind()'s initial sync can actually read: a
  // declared property is reported as present only when a value has been
  // cached (i.e. the server has synced or pushed an update for it). Without
  // this trap, `"value" in proxy` would fall through to the underlying
  // RemoteCoreProxy class and return false even for declared properties.
  has(target, prop) {
    if (typeof prop === "string" && target._hasCachedValue(prop)) {
      return true;
    }
    return Reflect.has(target, prop);
  },
  get(target, prop) {
    if (typeof prop === "string" && target._hasDeclaredProperty(prop)) {
      return target._getCachedValue(prop);
    }

    // Hide proxy internals like _values and _pending from external reads so
    // consumers only observe the declared remote surface.
    if (typeof prop === "string" && prop.startsWith("_")) {
      return undefined;
    }

    if (prop in target || typeof prop === "symbol") {
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function" && prop !== "constructor") {
        return value.bind(target);
      }
      return value;
    }
    return target._getCachedValue(prop as string);
  },
  set(target, prop, value) {
    if (typeof prop === "string" && target._isDeclaredInput(prop)) {
      target.set(prop, value);
      return true;
    }

    if (typeof prop === "string" && prop.startsWith("_")) {
      throw new Error(`RemoteCoreProxy: cannot assign to internal property "${prop}"`);
    }

    if (typeof prop === "string" && target._hasDeclaredProperty(prop)) {
      throw new Error(`RemoteCoreProxy: declared property "${prop}" is read-only; only wcBindable.inputs are assignable`);
    }

    if (typeof prop === "symbol" || prop in target) {
      return Reflect.set(target, prop, value, target);
    }

    throw new Error(`RemoteCoreProxy: cannot assign to undeclared property "${prop}"`);
  },
};

/** Synthetic event-name prefix used by proxy declarations. */
const PROXY_EVENT_PREFIX = "@wc-bindable/remote:";

// Names that, if used anywhere in the declared remote surface, would be
// shadowed by the real target before the Proxy can route them to cached
// properties, input setters, or command helpers.
const RESERVED_PROXY_MEMBER_NAMES: ReadonlySet<string> = (() => {
  const names = new Set<string>(["constructor"]);
  let proto: object | null = RemoteCoreProxy.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || name.startsWith("_")) continue;
      names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
})();

/**
 * Create a RemoteCoreProxy with an isolated `constructor.wcBindable`.
 *
 * Each call generates a unique subclass so that `isWcBindable()` and
 * `bind()` read the correct declaration per instance — multiple proxies
 * with different declarations can safely coexist on the same page.
 *
 * The returned object is wrapped in a Proxy so that declared property
 * names (e.g. `proxy.value`, `proxy.loading`) resolve from the internal
 * cache. This is required for `bind()`'s initial value synchronization.
 *
 * The proxy declaration rewrites each property's `event` to a synthetic
 * per-property name. This prevents collisions when the original Core
 * declares multiple properties on the same event (e.g. `value` and
 * `status` both driven by `my-fetch:response` with different getters) —
 * the wire protocol is property-centric, so the proxy must dispatch
 * per-property events internally for local `bind()` to discriminate.
 */
export function createRemoteCoreProxy(
  declaration: WcBindableDeclaration,
  transport: ClientTransport,
  options?: RemoteCoreProxyOptions,
): RemoteCoreProxy {
  // Two separate reasons a declared name must be rejected here:
  //   1. RESERVED_PROXY_MEMBER_NAMES — shadowed by the Proxy target, would
  //      break bind()/isWcBindable() / input / command routing locally.
  //   2. isReservedRemoteName — the wire validator drops messages carrying
  //      these names (see messageValidation.ts). Allowing them at
  //      construction would turn the property/command into a runtime black
  //      hole where all traffic is silently discarded. Fail fast instead.
  for (const p of declaration.properties) {
    if (RESERVED_PROXY_MEMBER_NAMES.has(p.name)) {
      throw new Error(
        `RemoteCoreProxy: property name "${p.name}" collides with a reserved EventTarget/proxy member and would break bind()/isWcBindable()`,
      );
    }
    if (isReservedRemoteName(p.name)) {
      throw new Error(
        `RemoteCoreProxy: property name "${p.name}" is reserved on the wire protocol and its sync/update messages would be dropped`,
      );
    }
  }

  for (const input of declaration.inputs ?? []) {
    if (RESERVED_PROXY_MEMBER_NAMES.has(input.name)) {
      throw new Error(
        `RemoteCoreProxy: input name "${input.name}" collides with a reserved EventTarget/proxy member and would break proxy input access`,
      );
    }
    if (isReservedRemoteName(input.name)) {
      throw new Error(
        `RemoteCoreProxy: input name "${input.name}" is reserved on the wire protocol and its set messages would be dropped`,
      );
    }
  }

  for (const command of declaration.commands ?? []) {
    if (RESERVED_PROXY_MEMBER_NAMES.has(command.name)) {
      throw new Error(
        `RemoteCoreProxy: command name "${command.name}" collides with a reserved EventTarget/proxy member and would break proxy command access`,
      );
    }
    if (isReservedRemoteName(command.name)) {
      throw new Error(
        `RemoteCoreProxy: command name "${command.name}" is reserved on the wire protocol and its cmd messages would be dropped`,
      );
    }
  }

  // Create a unique subclass per declaration so that
  // constructor.wcBindable is isolated per proxy instance.
  const proxyProperties = declaration.properties.map((p) => ({
    name: p.name,
    event: PROXY_EVENT_PREFIX + p.name,
  }));

  const proxyDeclaration: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: proxyProperties,
    inputs: declaration.inputs,
    commands: declaration.commands,
  };

  class IsolatedProxy extends RemoteCoreProxy {
    static wcBindable: WcBindableDeclaration = proxyDeclaration;
  }

  const instance = new IsolatedProxy(proxyDeclaration, transport, options);
  return new Proxy(instance, handler);
}
