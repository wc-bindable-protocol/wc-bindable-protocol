import { bind, type WcBindableDeclaration, type UnbindFn } from "@wc-bindable/core";
import type { ServerTransport, ClientMessage } from "./types.js";

/**
 * Server-side proxy that sits between the real Core and the network.
 *
 * It uses `bind()` to subscribe to the Core's events and forwards them
 * to the client via the transport. It also receives input property
 * assignments and command invocations from the client and applies them
 * to the Core.
 *
 * Usage:
 *   const core = new MyFetchCore();
 *   const shell = new RemoteShellProxy(core, transport);
 *   // Now the client's RemoteCoreProxy can interact with this Core.
 *   // Call shell.dispose() to clean up when the connection closes.
 */
export class RemoteShellProxy {
  private _core: EventTarget;
  private _transport: ServerTransport;
  private _declaration: WcBindableDeclaration;
  private _allowedInputs: Set<string>;
  private _allowedCommands: Set<string>;
  private _unbind: UnbindFn;
  private _disposed = false;

  constructor(core: EventTarget, transport: ServerTransport) {
    this._core = core;
    this._transport = transport;

    const ctor = core.constructor as { wcBindable?: WcBindableDeclaration };
    if (!ctor.wcBindable) {
      throw new Error("RemoteShellProxy: target must have static wcBindable declaration");
    }
    this._declaration = ctor.wcBindable;
    this._allowedInputs = new Set((this._declaration.inputs ?? []).map((i) => i.name));
    this._allowedCommands = new Set((this._declaration.commands ?? []).map((c) => c.name));

    // Subscribe to Core events via bind().
    // Skip initial values here — they are sent on "sync" request instead.
    // bind() fires initial values synchronously, so we flag them to ignore.
    // If bind() synchronously triggers real Core events through some side
    // effect, they are intentionally suppressed here as well: the following
    // sync response reads the latest property values and becomes the single
    // source of truth for that initialization window.
    // Forwarding is property-centric (not event-centric): when two properties
    // share an event and differ only by getter (e.g. value/status on the same
    // response event), bind() invokes this callback once per property with
    // its getter-applied value. Sending { name, value } preserves that
    // distinction — sending by event would collapse them.
    let initializing = true;
    this._unbind = bind(core, (name, value) => {
      if (initializing) return;
      transport.send({ type: "update", name, value });
    });
    initializing = false;

    // Listen for client messages.
    transport.onMessage((msg) => this._handleMessage(msg));
  }

  /** Read current values of all declared properties from the Core. */
  private _readCurrentValues(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const coreRecord = this._core as unknown as Record<string, unknown>;
    for (const prop of this._declaration.properties) {
      const v = coreRecord[prop.name];
      if (v !== undefined) {
        values[prop.name] = v;
      }
    }
    return values;
  }

  private _handleMessage(msg: ClientMessage): void {
    // The ServerTransport interface has no way to unregister an onMessage
    // handler, so dispose() sets this flag and we drop every subsequent
    // inbound message. This prevents late-arriving or reused-transport
    // messages from mutating the Core or invoking commands after teardown.
    if (this._disposed) return;
    switch (msg.type) {
      case "sync": {
        this._transport.send({ type: "sync", values: this._readCurrentValues() });
        break;
      }
      case "set": {
        if (!this._allowedInputs.has(msg.name)) return;
        // Isolate setter exceptions so a throwing setter (validation,
        // read-only property, type-conversion failure, etc.) does not
        // escape the transport's message handler and kill the connection.
        // `set` is fire-and-forget — there is no response id to surface
        // the error to the client. Applications that need feedback should
        // model the mutation as a command instead.
        try {
          (this._core as unknown as Record<string, unknown>)[msg.name] = msg.value;
        } catch (err) {
          console.error(
            `RemoteShellProxy: setter for "${msg.name}" threw:`,
            err,
          );
        }
        break;
      }
      case "cmd": {
        if (!this._allowedCommands.has(msg.name)) {
          this._transport.send({
            type: "throw",
            id: msg.id,
            error: `Command "${msg.name}" is not declared in wcBindable.commands`,
          });
          return;
        }
        const method = (this._core as unknown as Record<string, (...args: unknown[]) => unknown>)[msg.name];
        if (typeof method !== "function") {
          this._transport.send({
            type: "throw",
            id: msg.id,
            error: `Method "${msg.name}" not found on Core`,
          });
          return;
        }
        try {
          const result = method.call(this._core, ...msg.args);
          if (result instanceof Promise) {
            result
              .then((value) => {
                if (this._disposed) return;
                this._transport.send({ type: "return", id: msg.id, value });
              })
              .catch((err) => {
                if (this._disposed) return;
                this._transport.send({
                  type: "throw",
                  id: msg.id,
                  error: err instanceof Error ? err.message : err,
                });
              });
          } else {
            this._transport.send({ type: "return", id: msg.id, value: result });
          }
        } catch (err) {
          this._transport.send({
            type: "throw",
            id: msg.id,
            error: err instanceof Error ? err.message : err,
          });
        }
        break;
      }
    }
  }

  /**
   * Stop forwarding events from the Core and reject any further inbound
   * client messages. Call when the connection closes. Idempotent.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._unbind();
  }
}
