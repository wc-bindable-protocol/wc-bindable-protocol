import { describe, it, expect, vi, beforeEach } from "vitest";
import { bind, isWcBindable } from "@wc-bindable/core";
import type { WcBindableDeclaration } from "@wc-bindable/core";
import { createRemoteCoreProxy, RemoteCoreProxy } from "../src/RemoteCoreProxy.js";
import { RemoteShellProxy } from "../src/RemoteShellProxy.js";
import {
  RemoteCoreProxy as RemoteCoreProxyFromIndex,
  RemoteShellProxy as RemoteShellProxyFromIndex,
  WebSocketClientTransport,
  WebSocketServerTransport,
} from "../src/index.js";
import * as transportIndex from "../src/transport/index.js";
import type {
  ClientTransport,
  ServerTransport,
  ClientMessage,
  ServerMessage,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A mock transport pair that directly connects client and server. */
function createMockTransportPair(): {
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
function createSyncTransportPair(): {
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
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A simple test Core with wcBindable declaration. */
class TestCore extends EventTarget {
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

class MockBrowserWebSocket {
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

// ---------------------------------------------------------------------------
// RemoteCoreProxy
// ---------------------------------------------------------------------------

describe("RemoteCoreProxy", () => {
  it("exports the public API from the package barrels", () => {
    expect(RemoteCoreProxyFromIndex).toBe(RemoteCoreProxy);
    expect(RemoteShellProxyFromIndex).toBe(RemoteShellProxy);
    expect(transportIndex.WebSocketClientTransport).toBe(WebSocketClientTransport);
    expect(transportIndex.WebSocketServerTransport).toBe(WebSocketServerTransport);
  });

  it("is recognized by isWcBindable", () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    expect(isWcBindable(proxy)).toBe(true);
  });

  it("strips getters from the proxy declaration", () => {
    const declWithGetter: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "t:v", getter: (e) => (e as CustomEvent).detail.v },
      ],
    };
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(declWithGetter, client);
    const proxyDecl = (proxy.constructor as { wcBindable: WcBindableDeclaration }).wcBindable;
    expect(proxyDecl.properties[0].getter).toBeUndefined();
  });

  it("isolates wcBindable per proxy — multiple proxies with different declarations coexist", () => {
    const declA: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "alpha", event: "a:changed" }],
    };
    const declB: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "beta", event: "b:changed" }],
    };

    // Wire up transports that deliver event messages to the proxies.
    let handlerA: ((msg: ServerMessage) => void) | null = null;
    let handlerB: ((msg: ServerMessage) => void) | null = null;
    const clientA: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handlerA = h; },
    };
    const clientB: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handlerB = h; },
    };

    const proxyA = createRemoteCoreProxy(declA, clientA);
    const proxyB = createRemoteCoreProxy(declB, clientB);

    const declOfA = (proxyA.constructor as { wcBindable: WcBindableDeclaration }).wcBindable;
    const declOfB = (proxyB.constructor as { wcBindable: WcBindableDeclaration }).wcBindable;

    // Each proxy has its own declaration — not overwritten by the other.
    expect(declOfA.properties[0].name).toBe("alpha");
    expect(declOfB.properties[0].name).toBe("beta");

    // bind() subscribes to the correct events for each proxy.
    const onUpdateA = vi.fn();
    const onUpdateB = vi.fn();
    bind(proxyA, onUpdateA);
    bind(proxyB, onUpdateB);

    // Deliver events via transport (simulating server-side events).
    handlerA!({ type: "event", event: "a:changed", detail: 1 });
    handlerB!({ type: "event", event: "b:changed", detail: 2 });

    expect(onUpdateA).toHaveBeenCalledWith("alpha", 1);
    expect(onUpdateB).toHaveBeenCalledWith("beta", 2);
    expect(onUpdateA).not.toHaveBeenCalledWith("beta", expect.anything());
    expect(onUpdateB).not.toHaveBeenCalledWith("alpha", expect.anything());
  });

  it("sends sync request on construction", () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };
    createRemoteCoreProxy(TestCore.wcBindable, client);
    expect(send).toHaveBeenCalledWith({ type: "sync" });
  });

  it("populates cache and dispatches events on sync response", () => {
    const { client } = createSyncTransportPair();
    // Manually wire: server responds to sync with values.
    const serverSend = vi.fn();
    let serverHandler: ((msg: ClientMessage) => void) | null = null;
    const clientTransport: ClientTransport = {
      send: (msg) => { if (serverHandler) serverHandler(msg); },
      onMessage: (handler) => {
        // Wrap: when server sends, deliver to handler.
        serverSend.mockImplementation((m: ServerMessage) => handler(m));
      },
    };
    // Set up: server responds to sync.
    serverHandler = (msg) => {
      if (msg.type === "sync") {
        serverSend({ type: "sync", values: { value: "hello", loading: false } });
      }
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, clientTransport);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    // Initial sync values should have been delivered.
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");
    expect(onUpdate).toHaveBeenCalledWith("loading", false);
  });

  it("forwards set() as a set message", () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    proxy.set("url", "/api/data");
    expect(send).toHaveBeenCalledWith({ type: "set", name: "url", value: "/api/data" });
  });

  it("forwards invoke() as a cmd message and resolves on return", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const send = vi.fn();
    const client: ClientTransport = {
      send: (msg) => {
        send(msg);
        // Simulate server returning result.
        if (msg.type === "cmd") {
          handler!({ type: "return", id: msg.id, value: "result" });
        }
      },
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const result = await proxy.invoke("doFetch");
    expect(result).toBe("result");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cmd", name: "doFetch", args: [] }),
    );
  });

  it("rejects invoke() on throw message", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: (msg) => {
        if (msg.type === "cmd") {
          handler!({ type: "throw", id: msg.id, error: "boom" });
        }
      },
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    await expect(proxy.invoke("doFetch")).rejects.toBe("boom");
  });

  it("dispatches event messages as CustomEvents", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    handler!({ type: "event", event: "test:value-changed", detail: 42 });
    expect(onUpdate).toHaveBeenCalledWith("value", 42);
  });

  it("ignores sync values for undeclared properties", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    handler!({ type: "sync", values: { unknown: 123 } });

    expect(onUpdate).not.toHaveBeenCalled();
    expect((proxy as unknown as Record<string, unknown>).unknown).toBe(123);
  });

  it("updates cache on event messages so property access works", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    handler!({ type: "event", event: "test:value-changed", detail: "cached" });

    // Property access via Proxy should return cached value.
    expect((proxy as unknown as Record<string, unknown>).value).toBe("cached");
  });

  it("passes invoke arguments to the server", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const send = vi.fn();
    const client: ClientTransport = {
      send: (msg) => {
        send(msg);
        if (msg.type === "cmd") {
          handler!({ type: "return", id: msg.id, value: null });
        }
      },
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    await proxy.invoke("doFetch", "arg1", 2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cmd", name: "doFetch", args: ["arg1", 2] }),
    );
  });

  it("rejects all pending invocations when transport closes", async () => {
    let closeHandler: (() => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: (h) => { closeHandler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const p1 = proxy.invoke("doFetch");
    const p2 = proxy.invoke("abort");

    // Simulate transport closure.
    closeHandler!();

    await expect(p1).rejects.toThrow("Transport closed");
    await expect(p2).rejects.toThrow("Transport closed");
  });

  it("rejects all pending invocations when transport errors", async () => {
    let closeHandler: (() => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: (h) => { closeHandler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const p = proxy.invoke("doFetch");

    // Simulate transport error (onClose fires for both close and error).
    closeHandler!();

    await expect(p).rejects.toThrow("Transport closed");
  });

  it("invoke() on a closed transport rejects without leaking pending entries", async () => {
    let closed = false;
    const client: ClientTransport = {
      send: (msg) => {
        if (closed) throw new Error("connection is closed");
      },
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    // Simulate transport closing after construction.
    closed = true;
    const p = proxy.invoke("doFetch");

    await expect(p).rejects.toThrow("connection is closed");

    // Verify no pending entries leaked.
    const pending = (proxy as unknown as { _pending: Map<string, unknown> })._pending;
    expect(pending.size).toBe(0);
  });

  it("ignores return and throw messages for unknown command ids", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    createRemoteCoreProxy(TestCore.wcBindable, client);

    expect(() => {
      handler!({ type: "return", id: "missing", value: 1 });
      handler!({ type: "throw", id: "missing", error: "boom" });
    }).not.toThrow();
  });

  it("binds native EventTarget methods to the real target", () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onEvent = vi.fn();

    const addEventListenerFn = proxy.addEventListener;
    const dispatchEventFn = proxy.dispatchEvent;

    addEventListenerFn("manual", onEvent);
    dispatchEventFn(new Event("manual"));

    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe("WebSocketClientTransport", () => {
  it("buffers messages until the socket opens and then flushes them in order", () => {
    const ws = new MockBrowserWebSocket(WebSocket.CONNECTING);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);

    transport.send({ type: "sync" });
    transport.send({ type: "set", name: "url", value: "/api" });

    expect(ws.sent).toEqual([]);

    ws.emit("open");

    expect(ws.sent).toEqual([
      JSON.stringify({ type: "sync" }),
      JSON.stringify({ type: "set", name: "url", value: "/api" }),
    ]);
  });

  it("sends immediately when the socket is already open", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);

    transport.send({ type: "sync" });

    expect(ws.sent).toEqual([JSON.stringify({ type: "sync" })]);
  });

  it("throws when constructed with a closing or closed socket", () => {
    const closingTransport = new WebSocketClientTransport(
      new MockBrowserWebSocket(WebSocket.CLOSING) as unknown as WebSocket,
    );
    const closedTransport = new WebSocketClientTransport(
      new MockBrowserWebSocket(WebSocket.CLOSED) as unknown as WebSocket,
    );

    expect(() => closingTransport.send({ type: "sync" })).toThrow("connection is closed");
    expect(() => closedTransport.send({ type: "sync" })).toThrow("connection is closed");
  });

  it("parses incoming messages and notifies close handlers only once", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const onMessage = vi.fn();
    const onClose = vi.fn();

    transport.onMessage(onMessage);
    transport.onClose(onClose);

    ws.emit("message", { data: JSON.stringify({ type: "sync", values: { value: 1 } }) });
    ws.emit("close");
    ws.emit("error");

    expect(onMessage).toHaveBeenCalledWith({ type: "sync", values: { value: 1 } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("parses non-string message payloads via String(data)", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    ws.emit("message", {
      data: {
        toString: () => JSON.stringify({ type: "sync", values: { value: 2 } }),
      },
    });

    expect(onMessage).toHaveBeenCalledWith({ type: "sync", values: { value: 2 } });
  });

  it("marks a connecting socket as closed when it fails before opening", () => {
    const ws = new MockBrowserWebSocket(WebSocket.CONNECTING);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);

    ws.emit("error");

    expect(() => transport.send({ type: "sync" })).toThrow("connection is closed");
  });
});

describe("WebSocketServerTransport", () => {
  it("uses addEventListener when available", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    transport.send({ type: "sync", values: { ok: true } });
    ws.emit("message", { data: JSON.stringify({ type: "sync" }) });

    expect(ws.sent).toEqual([JSON.stringify({ type: "sync", values: { ok: true } })]);
    expect(onMessage).toHaveBeenCalledWith({ type: "sync" });
  });

  it("parses non-string addEventListener payloads via String(data)", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    ws.emit("message", {
      data: {
        toString: () => JSON.stringify({ type: "sync" }),
      },
    });

    expect(onMessage).toHaveBeenCalledWith({ type: "sync" });
  });

  it("falls back to EventEmitter style on(message)", () => {
    const listeners: Array<(data: unknown) => void> = [];
    const ws = {
      send: vi.fn(),
      on: (_type: "message", listener: (data: unknown) => void) => {
        listeners.push(listener);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    transport.send({ type: "sync", values: { ok: true } });
    listeners[0](JSON.stringify({ type: "set", name: "url", value: "/api" }));

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "sync", values: { ok: true } }));
    expect(onMessage).toHaveBeenCalledWith({ type: "set", name: "url", value: "/api" });
  });

  it("parses non-string EventEmitter payloads via String(data)", () => {
    const listeners: Array<(data: unknown) => void> = [];
    const ws = {
      send: vi.fn(),
      on: (_type: "message", listener: (data: unknown) => void) => {
        listeners.push(listener);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    listeners[0]({
      toString: () => JSON.stringify({ type: "sync" }),
    });

    expect(onMessage).toHaveBeenCalledWith({ type: "sync" });
  });

  it("does nothing when no message subscription API is available", () => {
    const ws = { send: vi.fn() };
    const transport = new WebSocketServerTransport(ws);

    expect(() => transport.onMessage(() => {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RemoteShellProxy
// ---------------------------------------------------------------------------

describe("RemoteShellProxy", () => {
  it("throws if Core lacks wcBindable declaration", () => {
    const { server } = createSyncTransportPair();
    expect(() => new RemoteShellProxy(new EventTarget(), server)).toThrow(
      "RemoteShellProxy: target must have static wcBindable declaration",
    );
  });

  it("does not send initial values on construction", () => {
    const core = new TestCore();
    (core as unknown as Record<string, unknown>)._value = "initial";
    const send = vi.fn();
    const server: ServerTransport = {
      send,
      onMessage: () => {},
    };
    new RemoteShellProxy(core, server);
    // No messages should be sent during construction.
    expect(send).not.toHaveBeenCalled();
  });

  it("responds to sync request with current values", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "sync" });

    expect(send).toHaveBeenCalledWith({
      type: "sync",
      values: { value: null, loading: false },
    });
  });

  it("handles declarations without inputs or commands and omits undefined current values", () => {
    class MinimalCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "missing", event: "minimal:changed" }],
      };

      get missing(): undefined {
        return undefined;
      }
    }

    const core = new MinimalCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "sync" });

    expect(send).toHaveBeenCalledWith({ type: "sync", values: {} });
  });

  it("forwards Core events to transport", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    core.dispatchEvent(new CustomEvent("test:value-changed", { detail: "hello" }));

    expect(send).toHaveBeenCalledWith({
      type: "event",
      event: "test:value-changed",
      detail: "hello",
    });
  });

  it("skips forwarding if the declaration no longer contains the emitted property", () => {
    const core = new TestCore();
    const send = vi.fn();
    const server: ServerTransport = {
      send,
      onMessage: () => {},
    };

    const shell = new RemoteShellProxy(core, server) as unknown as {
      _declaration: WcBindableDeclaration;
    };
    shell._declaration = {
      ...TestCore.wcBindable,
      properties: [{ name: "other", event: "other:changed" }],
    };

    core.dispatchEvent(new CustomEvent("test:value-changed", { detail: "ignored" }));

    expect(send).not.toHaveBeenCalled();
  });

  it("applies set messages to Core properties", () => {
    const core = new TestCore();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "url", value: "/api/users" });

    expect(core.url).toBe("/api/users");
  });

  it("handles sync cmd and returns result", async () => {
    const core = new TestCore();
    core.url = "/api/data";
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "abort", id: "1", args: [] });

    expect(send).toHaveBeenCalledWith({ type: "return", id: "1", value: undefined });
  });

  it("handles async cmd and returns resolved value", async () => {
    const core = new TestCore();
    core.url = "/test";
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "doFetch", id: "2", args: [] });

    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "return",
      id: "2",
      value: { data: "fetched:/test" },
    });
  });

  it("rejects cmd not declared in commands", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "nonExistent", id: "3", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "3",
      error: 'Command "nonExistent" is not declared in wcBindable.commands',
    });
  });

  it("rejects declared commands that are not functions on the core", () => {
    class InvalidCommandCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };
      boom = "not-a-function";
    }

    const core = new InvalidCommandCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "invalid", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "invalid",
      error: 'Method "boom" not found on Core',
    });
  });

  it("ignores set for properties not declared in inputs", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);

    // _value is a private field, not declared in inputs
    handler!({ type: "set", name: "_value", value: "hacked" });
    expect((core as unknown as Record<string, unknown>)._value).not.toBe("hacked");

    // url IS declared in inputs — should work
    handler!({ type: "set", name: "url", value: "/allowed" });
    expect(core.url).toBe("/allowed");
  });

  it("sends throw message when async cmd rejects", async () => {
    class FailCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "fail", async: true }],
      };
      async fail(): Promise<never> {
        throw new Error("something went wrong");
      }
    }

    const core = new FailCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "fail", id: "4", args: [] });

    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "4",
      error: "something went wrong",
    });
  });

  it("passes through non-Error async rejections", async () => {
    class StringRejectCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "fail" }],
      };

      async fail(): Promise<never> {
        throw "plain failure";
      }
    }

    const core = new StringRejectCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "fail", id: "string-async", args: [] });

    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "string-async",
      error: "plain failure",
    });
  });

  it("sends throw message when sync cmd throws", () => {
    class ThrowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };
      boom(): never {
        throw new Error("sync error");
      }
    }

    const core = new ThrowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "5", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "5",
      error: "sync error",
    });
  });

  it("passes through non-Error sync throws", () => {
    class StringThrowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };

      boom(): never {
        throw "plain sync failure";
      }
    }

    const core = new StringThrowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "boom", id: "string-sync", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "string-sync",
      error: "plain sync failure",
    });
  });

  it("stops forwarding events after dispose()", () => {
    const core = new TestCore();
    const send = vi.fn();
    const server: ServerTransport = {
      send,
      onMessage: () => {},
    };

    const shell = new RemoteShellProxy(core, server);
    shell.dispose();

    core.dispatchEvent(new CustomEvent("test:value-changed", { detail: "ignored" }));
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: RemoteCoreProxy + RemoteShellProxy
// ---------------------------------------------------------------------------

describe("end-to-end", () => {
  it("client receives initial state via sync", async () => {
    const { client, server } = createMockTransportPair();
    const core = new TestCore();
    new RemoteShellProxy(core, server);

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    await flush();

    expect(onUpdate).toHaveBeenCalledWith("loading", false);
  });

  it("client can set input and invoke command, receives events", async () => {
    const { client, server } = createMockTransportPair();
    const core = new TestCore();
    new RemoteShellProxy(core, server);

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    await flush(); // sync completes

    onUpdate.mockClear();

    proxy.set("url", "/api/items");
    await flush(); // set delivered

    const result = proxy.invoke("doFetch");
    await flush(); // cmd delivered, Core executes, events sent
    await flush(); // events delivered to client
    await flush(); // return delivered

    const resolved = await result;
    expect(resolved).toEqual({ data: "fetched:/api/items" });

    // Should have received loading and value events.
    expect(onUpdate).toHaveBeenCalledWith("loading", true);
    expect(onUpdate).toHaveBeenCalledWith("value", { data: "fetched:/api/items" });
    expect(onUpdate).toHaveBeenCalledWith("loading", false);
  });

  it("multiple sync requests return latest state", async () => {
    let clientHandler: ((msg: ServerMessage) => void) | null = null;
    let serverHandler: ((msg: ClientMessage) => void) | null = null;

    const client: ClientTransport = {
      send: (msg) => { if (serverHandler) serverHandler(msg); },
      onMessage: (h) => { clientHandler = h; },
    };
    const server: ServerTransport = {
      send: (msg) => { if (clientHandler) clientHandler(msg); },
      onMessage: (h) => { serverHandler = h; },
    };

    const core = new TestCore();
    new RemoteShellProxy(core, server);

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    // First sync already happened in constructor. Manually trigger another.
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    // Mutate Core state directly.
    (core as unknown as Record<string, unknown>)._value = "updated";
    // Trigger another sync.
    client.send({ type: "sync" });

    // value is private (_value) so won't appear in readCurrentValues via .value getter
    // loading should still be false.
    expect(onUpdate).toHaveBeenCalledWith("loading", false);
  });
});
