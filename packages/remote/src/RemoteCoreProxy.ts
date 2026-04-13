import type { WcBindableDeclaration } from "@wc-bindable/core";
import type { ClientTransport, ServerMessage } from "./types.js";

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
  private _transport: ClientTransport;
  private _eventsByName: Map<string, string>;
  private _values: Record<string, unknown> = {};
  private _pending: Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }> = new Map();
  private _cmdId = 0;

  constructor(declaration: WcBindableDeclaration, transport: ClientTransport) {
    super();
    this._eventsByName = new Map(declaration.properties.map((prop) => [prop.name, prop.event]));
    this._transport = transport;

    transport.onMessage((msg) => this._handleMessage(msg));
    transport.onClose?.(() => this._handleClose());

    // Request initial state from server.
    transport.send({ type: "sync" });
  }

  /** Set an input property on the remote Core. */
  set(name: string, value: unknown): void {
    this._transport.send({ type: "set", name, value });
  }

  /** Invoke a command on the remote Core and return its result. */
  invoke(name: string, ...args: unknown[]): Promise<unknown> {
    const id = String(++this._cmdId);
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._transport.send({ type: "cmd", name, id, args });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  private _handleClose(): void {
    const error = new Error("Transport closed");
    for (const [, pending] of this._pending) {
      pending.reject(error);
    }
    this._pending.clear();
  }

  private _handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "sync": {
        // Populate cache and dispatch events for each initial value.
        for (const [name, value] of Object.entries(msg.values)) {
          this._values[name] = value;
          const eventName = this._eventsByName.get(name);
          if (eventName) {
            this.dispatchEvent(new CustomEvent(eventName, { detail: value, bubbles: true }));
          }
        }
        break;
      }
      case "update": {
        // Update local cache by property name, then dispatch a per-property
        // event so local bind() picks it up. The proxy uses synthetic event
        // names (see createRemoteCoreProxy) to avoid collisions when multiple
        // properties share an event name on the Core side.
        this._values[msg.name] = msg.value;
        const eventName = this._eventsByName.get(msg.name);
        if (eventName) {
          this.dispatchEvent(new CustomEvent(eventName, { detail: msg.value, bubbles: true }));
        }
        break;
      }
      case "return": {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          pending.resolve(msg.value);
        }
        break;
      }
      case "throw": {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          pending.reject(msg.error);
        }
        break;
      }
    }
  }
}

// Proxy handler for property access on cached values.
// Native EventTarget methods (addEventListener, dispatchEvent, etc.) must
// be bound to the real target, not the Proxy — browsers throw "Illegal
// invocation" when native methods are called with a Proxy as `this`.
const handler: ProxyHandler<RemoteCoreProxy> = {
  get(target, prop) {
    if (prop in target || typeof prop === "symbol") {
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function" && prop !== "constructor") {
        return value.bind(target);
      }
      return value;
    }
    return (target as unknown as { _values: Record<string, unknown> })._values[prop as string];
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
