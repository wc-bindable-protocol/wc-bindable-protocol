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
    let initializing = true;
    this._unbind = bind(core, (name, value) => {
      if (initializing) return;
      const prop = this._declaration.properties.find((p) => p.name === name);
      if (prop) {
        transport.send({ type: "event", event: prop.event, detail: value });
      }
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
    switch (msg.type) {
      case "sync": {
        this._transport.send({ type: "sync", values: this._readCurrentValues() });
        break;
      }
      case "set": {
        if (!this._allowedInputs.has(msg.name)) return;
        (this._core as unknown as Record<string, unknown>)[msg.name] = msg.value;
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
                this._transport.send({ type: "return", id: msg.id, value });
              })
              .catch((err) => {
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

  /** Clean up event subscriptions. Call when the connection closes. */
  dispose(): void {
    this._unbind();
  }
}
