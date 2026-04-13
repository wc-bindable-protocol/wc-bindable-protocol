import type { WcBindableDeclaration } from "@wc-bindable/core";
import type { ClientTransport, ServerMessage, RemoteInvokeOptions } from "./types.js";

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

function createCommandId(getFallbackId: () => number): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return String(getFallbackId());
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
  private _values: Record<string, unknown> = {};
  private _pending: Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    cleanup: () => void;
  }> = new Map();
  private _cmdId = 0;
  private _connectionError: Error | null = null;
  private _disposedError: Error | null = null;
  private _transportGeneration = 0;

  constructor(declaration: WcBindableDeclaration, transport: ClientTransport) {
    super();
    this._eventsByName = new Map(declaration.properties.map((prop) => [prop.name, prop.event]));
    this._inputs = new Set((declaration.inputs ?? []).map((input) => input.name));

    this._attachTransport(transport);
  }

  /** Set an input property on the remote Core. */
  set(name: string, value: unknown): void {
    this._validateInputName(name);
    const transport = this._requireTransport();
    transport.send({ type: "set", name, value });
  }

  /** Set an input property and wait for the server to acknowledge or reject it. */
  setWithAck(name: string, value: unknown): Promise<void> {
    this._validateInputName(name);

    const transport = this._transport;
    if (this._disposedError) {
      return Promise.reject(this._disposedError);
    }
    if (!transport) {
      return Promise.reject(this._connectionError ?? new Error("Transport closed"));
    }

    const id = createCommandId(() => ++this._cmdId);
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve: () => resolve(),
        reject,
        cleanup: () => {},
      });

      try {
        transport.send({ type: "set", name, value, id });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
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

    const id = createCommandId(() => ++this._cmdId);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
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

      this._pending.set(id, { resolve, reject, cleanup });

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        transport.send({ type: "cmd", name, id, args });
      } catch (err) {
        this._pending.delete(id);
        cleanup();
        reject(err);
      }
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

  private _attachTransport(transport: ClientTransport): void {
    const generation = ++this._transportGeneration;
    this._transport = transport;
    this._connectionError = null;

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
      this._transport = null;
      this._connectionError = err instanceof Error ? err : new Error(String(err));
      this._transportGeneration++;
      this._disposeTransport(transport);
      throw err;
    }
  }

  private _handleMessage(msg: ServerMessage): void {
    if (this._disposedError) return;
    switch (msg.type) {
      case "sync": {
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
          pending.reject(msg.error);
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
      throw new Error(`RemoteCoreProxy: cannot assign to undeclared property "${prop}"`);
    }

    if (typeof prop === "symbol" || prop in target) {
      return Reflect.set(target, prop, value, target);
    }

    throw new Error(`RemoteCoreProxy: cannot assign to undeclared property "${prop}"`);
  },
};

/** Synthetic event-name prefix used by proxy declarations. */
const PROXY_EVENT_PREFIX = "@wc-bindable/remote:";

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
