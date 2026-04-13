import type { WcBindableDeclaration } from "@wc-bindable/core";
import type {
  ClientTransport,
  ServerMessage,
  RemoteInvokeOptions,
  RemoteSerializedError,
} from "./types.js";
import { isReservedRemoteName } from "./transport/messageValidation.js";

const DEFAULT_PENDING_TIMEOUT_MS = 30_000;

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

function normalizeTimeoutMs(options?: RemoteInvokeOptions): number | null {
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

  constructor(declaration: WcBindableDeclaration, transport: ClientTransport) {
    super();
    this._eventsByName = new Map(declaration.properties.map((prop) => [prop.name, prop.event]));
    this._inputs = new Set((declaration.inputs ?? []).map((input) => input.name));
    this._commands = new Set((declaration.commands ?? []).map((command) => command.name));

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
  setWithAckOptions(name: string, value: unknown, options: RemoteInvokeOptions): Promise<void> {
    this._validateInputName(name);
    if (this._setAckSupported === false) {
      return Promise.reject(
        new Error("RemoteCoreProxy: remote server does not support setWithAck(); use set() or upgrade the server"),
      );
    }

    const transport = this._transport;
    if (this._disposedError) {
      return Promise.reject(this._disposedError);
    }
    if (!transport) {
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
        try {
          transport.send({ type: "set", name, value, id });
        } catch (err) {
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

  /** Invoke a command on the remote Core with lifecycle options such as AbortSignal. */
  invokeWithOptions(name: string, options: RemoteInvokeOptions, ...args: unknown[]): Promise<unknown> {
    return this._invoke(name, args, options);
  }

  private _invoke(name: string, args: unknown[], options?: RemoteInvokeOptions): Promise<unknown> {
    if (!this._commands.has(name)) {
      return Promise.reject(
        new Error(`RemoteCoreProxy: command "${name}" is not declared in wcBindable.commands`),
      );
    }
    const transport = this._transport;
    if (this._disposedError) {
      return Promise.reject(this._disposedError);
    }
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
        try {
          transport.send({ type: "cmd", name, id, args });
        } catch (err) {
          // _handleSendFailure rejects all pending (including this id) and
          // clears the transport so reconnect() can attach a new one.
          this._handleSendFailure(transport, err);
        }
      },
    );
  }

  private _createPendingRequest<T>(
    kind: "set-ack" | "invoke",
    options: RemoteInvokeOptions | undefined,
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
        if (!signal) return;
        const pending = this._pending.get(id);
        if (!pending) return;
        this._pending.delete(id);
        pending.cleanup();
        pending.reject(createAbortError(signal));
      };
      const onTimeout = () => {
        const pending = this._pending.get(id);
        if (!pending || timeoutMs === null) return;
        this._pending.delete(id);
        pending.cleanup();
        pending.reject(createTimeoutError(timeoutContext, timeoutMs));
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
    const error = new Error("RemoteCoreProxy disposed");
    const transport = this._transport;
    this._disposedError = error;
    this._connectionError = error;
    this._transport = null;
    this._transportGeneration++;
    this._rejectPending(error);
    this._disposeTransport(transport);
  }

  private _handleClose(): void {
    if (this._disposedError) return;
    const transport = this._transport;
    this._connectionError = new Error("Transport closed");
    this._transport = null;
    this._transportGeneration++;
    this._rejectPending(this._connectionError);
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
    const error = err instanceof Error ? err : new Error(String(err));
    if (this._disposedError) return this._disposedError;
    if (this._transport !== transport) return error;
    this._connectionError = error;
    this._transport = null;
    this._transportGeneration++;
    this._rejectPending(error);
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
      throw this._connectionError ?? new Error("Transport closed");
    }
    return this._transport;
  }

  private _disposeTransport(transport: ClientTransport | null): void {
    if (!transport?.dispose) return;
    transport.dispose();
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

    transport.onMessage((msg) => {
      if (generation !== this._transportGeneration) return;
      this._handleMessage(msg);
    });
    transport.onClose?.(() => {
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
    if (this._disposedError) return;
    switch (msg.type) {
      case "sync": {
        this._setAckSupported = msg.capabilities?.setAck === true;
        if (!this._setAckSupported) {
          this._rejectUnsupportedSetAckPending();
        }
        const getterFailures = new Set(msg.getterFailures ?? []);
        // Populate cache and dispatch events for each initial value.
        for (const [name, value] of Object.entries(msg.values)) {
          const eventName = this._eventsByName.get(name);
          if (!eventName) {
            console.warn(`RemoteCoreProxy: ignored sync value for undeclared property "${name}"`);
            continue;
          }

          this._values[name] = value;
          this.dispatchEvent(new CustomEvent(eventName, { detail: value }));
        }
        // Reset declared properties that were cached but omitted from this
        // sync. The server omits properties whose current value is undefined
        // (see README "Connection lifecycle"), so an absent entry on a
        // re-sync means the property has reverted to undefined upstream —
        // the cached value would otherwise stay stale and bind() subscribers
        // would never observe the reset.
        for (const name of this._eventsByName.keys()) {
          if (Object.prototype.hasOwnProperty.call(msg.values, name)) continue;
          if (getterFailures.has(name)) continue;
          if (this._values[name] === undefined) continue;
          this._values[name] = undefined;
          const eventName = this._eventsByName.get(name);
          if (eventName) {
            this.dispatchEvent(new CustomEvent(eventName, { detail: undefined }));
          }
        }
        break;
      }
      case "update": {
        // Update local cache by property name, then dispatch a per-property
        // event so local bind() picks it up. The proxy uses synthetic event
        // names (see createRemoteCoreProxy) to avoid collisions when multiple
        // properties share an event name on the Core side.
        const eventName = this._eventsByName.get(msg.name);
        if (!eventName) {
          console.warn(`RemoteCoreProxy: ignored update for undeclared property "${msg.name}"`);
          break;
        }

        this._values[msg.name] = msg.value;
        this.dispatchEvent(new CustomEvent(eventName, { detail: msg.value }));
        break;
      }
      case "return": {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          pending.cleanup();
          pending.resolve(msg.value);
        } else {
          console.warn(`RemoteCoreProxy: received return for unknown request id "${msg.id}"`);
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
          console.warn(`RemoteCoreProxy: received throw for unknown request id "${msg.id}"`);
        }
        break;
      }
    }
  }

  _hasDeclaredProperty(name: string): boolean {
    return this._eventsByName.has(name);
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

  const instance = new IsolatedProxy(proxyDeclaration, transport);
  return new Proxy(instance, handler);
}
