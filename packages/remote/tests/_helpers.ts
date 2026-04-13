import type { WcBindableDeclaration } from "@wc-bindable/core";
import type {
  ClientTransport,
  ServerTransport,
  ClientMessage,
  ServerMessage,
} from "../src/types.js";

/** A mock transport pair that directly connects client and server. */
export function createMockTransportPair(): {
  client: ClientTransport;
  server: ServerTransport;
} {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;

  const client: ClientTransport = {
    send: (msg) => {
      // Deliver to server handler asynchronously to simulate real transport.
      if (serverHandler) Promise.resolve().then(() => serverHandler!(msg));
    },
    onMessage: (handler) => {
      clientHandler = handler;
    },
  };

  const server: ServerTransport = {
    send: (msg) => {
      if (clientHandler) Promise.resolve().then(() => clientHandler!(msg));
    },
    onMessage: (handler) => {
      serverHandler = handler;
    },
  };

  return { client, server };
}

/** A synchronous transport pair — messages are delivered immediately. */
export function createSyncTransportPair(): {
  client: ClientTransport;
  server: ServerTransport;
} {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;

  const client: ClientTransport = {
    send: (msg) => { if (serverHandler) serverHandler(msg); },
    onMessage: (handler) => { clientHandler = handler; },
  };

  const server: ServerTransport = {
    send: (msg) => { if (clientHandler) clientHandler(msg); },
    onMessage: (handler) => { serverHandler = handler; },
  };

  return { client, server };
}

/** Flush microtasks so async transport deliveries complete. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A simple test Core with wcBindable declaration. */
export class TestCore extends EventTarget {
  static wcBindable: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "test:value-changed" },
      { name: "loading", event: "test:loading-changed" },
    ],
    inputs: [
      { name: "url" },
    ],
    commands: [
      { name: "doFetch", async: true },
      { name: "abort" },
    ],
  };

  private _value: unknown = null;
  private _loading = false;
  private _url = "";
  private _target: EventTarget;

  constructor(target?: EventTarget) {
    super();
    this._target = target ?? this;
  }

  get value(): unknown { return this._value; }
  get loading(): boolean { return this._loading; }
  get url(): string { return this._url; }
  set url(v: string) { this._url = v; }

  async doFetch(): Promise<unknown> {
    this._loading = true;
    this._target.dispatchEvent(new CustomEvent("test:loading-changed", { detail: true }));
    const result = { data: "fetched:" + this._url };
    this._value = result;
    this._loading = false;
    this._target.dispatchEvent(new CustomEvent("test:value-changed", { detail: result }));
    this._target.dispatchEvent(new CustomEvent("test:loading-changed", { detail: false }));
    return result;
  }

  abort(): void {
    this._loading = false;
    this._target.dispatchEvent(new CustomEvent("test:loading-changed", { detail: false }));
  }
}

export class MockBrowserWebSocket {
  readyState: number;
  sent: string[] = [];
  private _listeners = new Map<string, Array<{ listener: (event?: unknown) => void; once: boolean }>>();

  constructor(readyState: number) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  addEventListener(type: string, listener: (event?: unknown) => void, options?: boolean | AddEventListenerOptions): void {
    const once = typeof options === "object" && options?.once === true;
    const entries = this._listeners.get(type) ?? [];
    entries.push({ listener, once });
    this._listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: (event?: unknown) => void): void {
    const entries = this._listeners.get(type) ?? [];
    const kept = entries.filter((entry) => entry.listener !== listener);

    if (kept.length > 0) {
      this._listeners.set(type, kept);
    } else {
      this._listeners.delete(type);
    }
  }

  listenerCount(type: string): number {
    return (this._listeners.get(type) ?? []).length;
  }

  emit(type: string, event?: unknown): void {
    const entries = [...(this._listeners.get(type) ?? [])];
    const kept: Array<{ listener: (event?: unknown) => void; once: boolean }> = [];

    for (const entry of entries) {
      entry.listener(event);
      if (!entry.once) {
        kept.push(entry);
      }
    }

    if (kept.length > 0) {
      this._listeners.set(type, kept);
    } else {
      this._listeners.delete(type);
    }
  }
}
