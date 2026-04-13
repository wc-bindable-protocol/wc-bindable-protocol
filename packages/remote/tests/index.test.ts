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
    handlerA!({ type: "update", name: "alpha", value: 1 });
    handlerB!({ type: "update", name: "beta", value: 2 });

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

  it("setWithAck() sends a set message with an id and resolves on return", async () => {
    const send = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pending = proxy.setWithAck("url", "/api/ack");

    expect(send).toHaveBeenLastCalledWith({
      type: "set",
      name: "url",
      value: "/api/ack",
      id: expect.any(String),
    });

    const requestId = send.mock.calls.at(-1)?.[0]?.id as string;
    handler!({ type: "return", id: requestId, value: undefined });

    await expect(pending).resolves.toBeUndefined();
  });

  it("setWithAck() rejects on throw response", async () => {
    const send = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pending = proxy.setWithAck("url", 123);
    const requestId = send.mock.calls.at(-1)?.[0]?.id as string;

    handler!({
      type: "throw",
      id: requestId,
      error: { name: "TypeError", message: "invalid url" },
    });

    await expect(pending).rejects.toEqual({ name: "TypeError", message: "invalid url" });
  });

  it("throws on set() for undeclared inputs without sending", () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    expect(() => proxy.set("value", "nope")).toThrow(
      'RemoteCoreProxy: input "value" is not declared in wcBindable.inputs',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("validates input name on set() even after transport close or dispose", () => {
    let closeHandler: (() => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: (h) => { closeHandler = h; },
    };

    const closedProxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    closeHandler!();
    expect(() => closedProxy.set("typo", "nope")).toThrow(
      'RemoteCoreProxy: input "typo" is not declared in wcBindable.inputs',
    );

    const disposedProxy = createRemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    });
    disposedProxy.dispose();
    expect(() => disposedProxy.set("typo", "nope")).toThrow(
      'RemoteCoreProxy: input "typo" is not declared in wcBindable.inputs',
    );
  });

  it("forwards direct assignment for declared inputs as a set message", () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy & { url: string };
    proxy.url = "/api/direct";

    expect(send).toHaveBeenCalledWith({ type: "set", name: "url", value: "/api/direct" });
  });

  it("throws on direct assignment to undeclared properties", () => {
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy & { value: unknown };

    expect(() => {
      proxy.value = "local";
    }).toThrow('RemoteCoreProxy: cannot assign to undeclared property "value"');
  });

  it("rejects assignment to declared properties that collide with inherited members", () => {
    const declWithCollision: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "toString", event: "test:to-string" }],
    };

    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(declWithCollision, client) as RemoteCoreProxy & { toString: unknown };

    expect(() => {
      proxy.toString = "local";
    }).toThrow('RemoteCoreProxy: cannot assign to undeclared property "toString"');
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

  it("uses crypto.randomUUID() for command ids when available", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const send = vi.fn();
    const client: ClientTransport = {
      send: (msg) => {
        send(msg);
        if (msg.type === "cmd") {
          handler!({ type: "return", id: msg.id, value: "uuid-result" });
        }
      },
      onMessage: (h) => { handler = h; },
    };

    const randomUuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("cmd-uuid");

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    await expect(proxy.invoke("doFetch")).resolves.toBe("uuid-result");
    expect(send).toHaveBeenCalledWith({ type: "cmd", name: "doFetch", id: "cmd-uuid", args: [] });

    randomUuidSpy.mockRestore();
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

  it("dispatches update messages through bind()", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    handler!({ type: "update", name: "value", value: 42 });
    expect(onUpdate).toHaveBeenCalledWith("value", 42);
  });

  it("preserves per-property updates when Core properties share an event name", () => {
    // Mirrors MyFetchCore: `value` and `status` are driven by the same
    // server-side event but distinguished by getters. The wire protocol
    // must carry each property independently.
    const sharedDecl: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "my-fetch:response", getter: (e) => (e as CustomEvent).detail.value },
        { name: "status", event: "my-fetch:response", getter: (e) => (e as CustomEvent).detail.status },
      ],
    };

    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(sharedDecl, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    handler!({ type: "update", name: "value", value: { hello: "world" } });
    handler!({ type: "update", name: "status", value: 200 });

    expect(onUpdate).toHaveBeenCalledWith("value", { hello: "world" });
    expect(onUpdate).toHaveBeenCalledWith("status", 200);
    expect((proxy as unknown as Record<string, unknown>).value).toEqual({ hello: "world" });
    expect((proxy as unknown as Record<string, unknown>).status).toBe(200);
  });

  it("ignores sync values for undeclared properties", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bind(proxy, onUpdate);

    handler!({ type: "sync", values: { unknown: 123 } });

    expect(onUpdate).not.toHaveBeenCalled();
    expect((proxy as unknown as Record<string, unknown>).unknown).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'RemoteCoreProxy: ignored sync value for undeclared property "unknown"',
    );

    warnSpy.mockRestore();
  });

  it("ignores update messages for undeclared properties", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bind(proxy, onUpdate);

    handler!({ type: "update", name: "unknown", value: 123 });

    expect(onUpdate).not.toHaveBeenCalled();
    expect((proxy as unknown as Record<string, unknown>).unknown).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'RemoteCoreProxy: ignored update for undeclared property "unknown"',
    );

    warnSpy.mockRestore();
  });

  it("updates cache on update messages so property access works", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    handler!({ type: "update", name: "value", value: "cached" });

    // Property access via Proxy should return cached value.
    expect((proxy as unknown as Record<string, unknown>).value).toBe("cached");
  });

  it("prefers declared property values over inherited prototype members", () => {
    const declWithCollision: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "toString", event: "test:to-string" }],
    };

    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(declWithCollision, client) as RemoteCoreProxy & { toString: unknown };
    handler!({ type: "update", name: "toString", value: "remote-value" });

    expect(proxy.toString).toBe("remote-value");
  });

  it("does not expose internal cache fields through the proxy", () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy & { _values?: unknown };

    expect(proxy._values).toBeUndefined();
    expect(() => {
      (proxy as RemoteCoreProxy & { _values: unknown })._values = {};
    }).toThrow('RemoteCoreProxy: cannot assign to internal property "_values"');
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

  it("rejects invokeWithOptions() immediately when the signal is already aborted", async () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };
    const controller = new AbortController();
    controller.abort();

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    await expect(proxy.invokeWithOptions("doFetch", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects invokeWithOptions() when aborted in flight and clears pending state", async () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };
    const controller = new AbortController();

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pendingInvoke = proxy.invokeWithOptions("doFetch", { signal: controller.signal });

    controller.abort();

    await expect(pendingInvoke).rejects.toMatchObject({ name: "AbortError" });

    const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
    expect(pending.size).toBe(0);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "cmd", name: "doFetch" }));
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

  it("can reconnect after transport close without losing subscribers", async () => {
    let firstHandler: ((msg: ServerMessage) => void) | null = null;
    let firstCloseHandler: (() => void) | null = null;
    const firstSend = vi.fn();
    const firstClient: ClientTransport = {
      send: firstSend,
      onMessage: (handler) => { firstHandler = handler; },
      onClose: (handler) => { firstCloseHandler = handler; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, firstClient);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    firstCloseHandler!();

    expect(() => proxy.set("url", "/disconnected")).toThrow("Transport closed");

    let secondHandler: ((msg: ServerMessage) => void) | null = null;
    let secondCloseHandler: (() => void) | null = null;
    const secondSend = vi.fn();
    const secondClient: ClientTransport = {
      send: secondSend,
      onMessage: (handler) => { secondHandler = handler; },
      onClose: (handler) => { secondCloseHandler = handler; },
    };

    proxy.reconnect(secondClient);
    expect(secondSend).toHaveBeenCalledWith({ type: "sync" });

    firstHandler!({ type: "update", name: "value", value: "stale" });
    expect((proxy as unknown as Record<string, unknown>).value).not.toBe("stale");

    secondHandler!({ type: "sync", values: { value: "fresh", loading: false } });
    expect((proxy as unknown as Record<string, unknown>).value).toBe("fresh");
    expect(onUpdate).toHaveBeenCalledWith("value", "fresh");

    secondCloseHandler!();
    await expect(proxy.invoke("doFetch")).rejects.toThrow("Transport closed");
  });

  it("clears cached properties omitted from a sync payload", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    // Server initially has a value cached on the client.
    handler!({ type: "sync", values: { value: "hello", loading: true } });
    expect((proxy as unknown as Record<string, unknown>).value).toBe("hello");
    expect((proxy as unknown as Record<string, unknown>).loading).toBe(true);

    onUpdate.mockClear();

    // Server reverts `value` to undefined and omits it from the next sync
    // (per protocol). Cached value must be cleared and subscribers notified.
    // Note: CustomEvent normalizes `detail: undefined` to `null`, so the
    // bind() callback observes null while the cache reads back as undefined.
    handler!({ type: "sync", values: { loading: false } });
    expect((proxy as unknown as Record<string, unknown>).value).toBeUndefined();
    expect((proxy as unknown as Record<string, unknown>).loading).toBe(false);
    expect(onUpdate).toHaveBeenCalledWith("value", null);
    expect(onUpdate).toHaveBeenCalledWith("loading", false);
  });

  it("rejects reconnect() while connected or after dispose()", () => {
    const activeClient: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, activeClient);

    expect(() => proxy.reconnect(activeClient)).toThrow("RemoteCoreProxy: transport is already connected");

    proxy.dispose();

    expect(() => proxy.reconnect(activeClient)).toThrow("RemoteCoreProxy disposed");
  });

  it("dispose() rejects all pending invocations and is idempotent", async () => {
    const dispose = vi.fn();
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      dispose,
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const p1 = proxy.invoke("doFetch");
    const p2 = proxy.invoke("abort");

    proxy.dispose();
    proxy.dispose();

    await expect(p1).rejects.toThrow("RemoteCoreProxy disposed");
    await expect(p2).rejects.toThrow("RemoteCoreProxy disposed");
    expect(dispose).toHaveBeenCalledTimes(1);

    const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
    expect(pending.size).toBe(0);
  });

  it("disposes the owned transport when the transport closes", async () => {
    let closeHandler: (() => void) | null = null;
    const dispose = vi.fn();
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: (handler) => { closeHandler = handler; },
      dispose,
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pendingInvoke = proxy.invoke("doFetch");

    closeHandler!();

    await expect(pendingInvoke).rejects.toThrow("Transport closed");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects further set() and invoke() calls after dispose()", async () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    proxy.dispose();

    expect(() => proxy.set("url", "/after-dispose")).toThrow("RemoteCoreProxy disposed");
    await expect(proxy.invoke("doFetch")).rejects.toThrow("RemoteCoreProxy disposed");
    expect(send).toHaveBeenCalledTimes(1);
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
    const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
    expect(pending.size).toBe(0);
  });

  it("ignores return and throw messages for unknown request ids", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    createRemoteCoreProxy(TestCore.wcBindable, client);

    expect(() => {
      handler!({ type: "return", id: "missing", value: 1 });
      handler!({ type: "throw", id: "missing", error: "boom" });
    }).not.toThrow();

    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      'RemoteCoreProxy: received return for unknown request id "missing"',
    );
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      'RemoteCoreProxy: received throw for unknown request id "missing"',
    );

    warnSpy.mockRestore();
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

  it("replaces the previous onMessage handler when called again", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const first = vi.fn();
    const second = vi.fn();

    transport.onMessage(first);
    transport.onMessage(second);

    expect(ws.listenerCount("message")).toBe(1);

    ws.emit("message", { data: JSON.stringify({ type: "sync", values: { value: 1 } }) });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ type: "sync", values: { value: 1 } });
  });

  it("ignores parsed server messages with invalid shape", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const onMessage = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(onMessage);
    ws.emit("message", { data: JSON.stringify({ type: "update", value: 2 }) });

    expect(onMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "WebSocketClientTransport: ignoring invalid server message",
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("dispose() removes WebSocket listeners", () => {
    const ws = new MockBrowserWebSocket(WebSocket.CONNECTING);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const onMessage = vi.fn();
    const onClose = vi.fn();

    transport.onMessage(onMessage);
    transport.onClose(onClose);

    expect(ws.listenerCount("message")).toBe(1);
    expect(ws.listenerCount("close")).toBe(2);
    expect(ws.listenerCount("error")).toBe(2);

    transport.dispose();

    expect(ws.listenerCount("message")).toBe(0);
    expect(ws.listenerCount("close")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);

    ws.emit("message", { data: JSON.stringify({ type: "sync", values: { value: 1 } }) });
    ws.emit("close");

    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("replaces the previous onClose handler when called again", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const first = vi.fn();
    const second = vi.fn();

    transport.onClose(first);
    transport.onClose(second);

    expect(ws.listenerCount("close")).toBe(2);
    expect(ws.listenerCount("error")).toBe(2);

    ws.emit("close");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("marks a connecting socket as closed when it fails before opening", () => {
    const ws = new MockBrowserWebSocket(WebSocket.CONNECTING);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);

    ws.emit("error");

    expect(() => transport.send({ type: "sync" })).toThrow("connection is closed");
  });

  it("marks an initially-open socket as closed when it later closes", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);

    // Send works while open.
    transport.send({ type: "sync" });
    expect(ws.sent).toEqual([JSON.stringify({ type: "sync" })]);

    // Socket closes after transport construction — subsequent sends must
    // surface a consistent "connection is closed" error rather than
    // attempting ws.send on a dead socket.
    ws.emit("close");

    expect(() => transport.send({ type: "set", name: "url", value: "/api" }))
      .toThrow("connection is closed");
  });

  it("marks an initially-open socket as closed when it later errors", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
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

  it("parses Buffer payloads from EventEmitter-style sockets", () => {
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
    listeners[0](Buffer.from(JSON.stringify({ type: "set", name: "url", value: "/buffer" }), "utf8"));

    expect(onMessage).toHaveBeenCalledWith({ type: "set", name: "url", value: "/buffer" });
  });

  it("ignores parsed client messages with invalid shape", () => {
    const listeners: Array<(data: unknown) => void> = [];
    const ws = {
      send: vi.fn(),
      on: (_type: "message", listener: (data: unknown) => void) => {
        listeners.push(listener);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onMessage = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(onMessage);
    listeners[0](JSON.stringify({ type: "cmd", name: "doFetch", args: [] }));

    expect(onMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "WebSocketServerTransport: ignoring invalid client message",
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("does nothing when no message subscription API is available", () => {
    const ws = { send: vi.fn() };
    const transport = new WebSocketServerTransport(ws);

    expect(() => transport.onMessage(() => {})).not.toThrow();
  });

  it("notifies close handlers when using addEventListener", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const onClose = vi.fn();

    transport.onClose(onClose);
    ws.emit("error");
    ws.emit("close");
    ws.emit("close");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("notifies close handlers when falling back to EventEmitter style", () => {
    const closeListeners: Array<() => void> = [];
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: ((data: unknown) => void) | (() => void)) => {
        if (type === "close" || type === "error") {
          closeListeners.push(listener as () => void);
        }
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onClose = vi.fn();

    transport.onClose(onClose);
    closeListeners[0]();
    closeListeners[1]();

    expect(onClose).toHaveBeenCalledTimes(1);
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

  it("logs and swallows sync send failures", () => {
    const core = new TestCore();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send: () => {
        throw new TypeError("Converting circular structure to JSON");
      },
      onMessage: (h) => { handler = h; },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    new RemoteShellProxy(core, server);

    expect(() => handler!({ type: "sync" })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "RemoteShellProxy: failed to send sync response:",
      expect.any(TypeError),
    );

    errorSpy.mockRestore();
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

  it("logs and skips properties whose getters throw during sync", () => {
    class ThrowingGetterCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "ok", event: "throwing:ok" },
          { name: "bad", event: "throwing:bad" },
        ],
      };

      get ok(): string {
        return "value";
      }

      get bad(): never {
        throw new Error("broken getter");
      }
    }

    const core = new ThrowingGetterCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    new RemoteShellProxy(core, server);

    expect(() => handler!({ type: "sync" })).not.toThrow();
    expect(send).toHaveBeenCalledWith({ type: "sync", values: { ok: "value" } });
    expect(errorSpy).toHaveBeenCalledWith(
      'RemoteShellProxy: getter for "bad" threw during sync:',
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });

  it("queues updates emitted while building a sync snapshot until after sync", () => {
    class SyncSideEffectCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "value", event: "sync-side-effect:value" },
          { name: "status", event: "sync-side-effect:status" },
        ],
      };

      get value(): string {
        this.dispatchEvent(new CustomEvent("sync-side-effect:status", { detail: "queued" }));
        return "snapshot";
      }

      get status(): string {
        return "current";
      }
    }

    const core = new SyncSideEffectCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "sync" });

    expect(send).toHaveBeenNthCalledWith(1, {
      type: "sync",
      values: { value: "snapshot", status: "current" },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: "update",
      name: "status",
      value: "queued",
    });
  });

  it("forwards Core events to transport as property updates", () => {
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
      type: "update",
      name: "value",
      value: "hello",
    });
  });

  it("logs and swallows update send failures", () => {
    const core = new TestCore();
    const server: ServerTransport = {
      send: () => {
        throw new TypeError("Do not know how to serialize a BigInt");
      },
      onMessage: () => {},
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      new RemoteShellProxy(core, server);
      core.dispatchEvent(new CustomEvent("test:value-changed", { detail: 1n }));
    }).not.toThrow();

    expect(errorSpy).toHaveBeenCalledWith(
      'RemoteShellProxy: failed to send update for "value":',
      expect.any(TypeError),
    );

    errorSpy.mockRestore();
  });

  it("forwards shared-event properties as separate updates with getter-applied values", () => {
    class SharedEventCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "value", event: "shared:response", getter: (e) => (e as CustomEvent).detail.value },
          { name: "status", event: "shared:response", getter: (e) => (e as CustomEvent).detail.status },
        ],
      };
    }

    const core = new SharedEventCore();
    const send = vi.fn();
    const server: ServerTransport = {
      send,
      onMessage: () => {},
    };

    new RemoteShellProxy(core, server);
    core.dispatchEvent(
      new CustomEvent("shared:response", { detail: { value: { ok: true }, status: 200 } }),
    );

    // Two distinct updates — one per property — with getter-applied values.
    expect(send).toHaveBeenCalledWith({ type: "update", name: "value", value: { ok: true } });
    expect(send).toHaveBeenCalledWith({ type: "update", name: "status", value: 200 });
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

  it("acknowledges setWithAck messages after applying the input", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "url", value: "/api/ack", id: "set-1" });

    expect(core.url).toBe("/api/ack");
    expect(send).toHaveBeenCalledWith({ type: "return", id: "set-1", value: undefined });
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

  it("awaits thenable return values (not just native Promise instances)", async () => {
    class ThenableCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "thenable", async: true }],
      };
      thenable(): PromiseLike<string> {
        return {
          then(onFulfilled) {
            return Promise.resolve(onFulfilled ? onFulfilled("resolved-via-thenable") : "resolved-via-thenable");
          },
        } as PromiseLike<string>;
      }
    }

    const core = new ThenableCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "thenable", id: "thenable-1", args: [] });

    await flush();
    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "return",
      id: "thenable-1",
      value: "resolved-via-thenable",
    });
  });

  it("propagates rejections from thenable return values as throw messages", async () => {
    class RejectingThenableCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "fail", async: true }],
      };
      fail(): PromiseLike<never> {
        return {
          then(_onFulfilled, onRejected) {
            return Promise.resolve(onRejected ? onRejected(new Error("thenable boom")) : undefined);
          },
        } as PromiseLike<never>;
      }
    }

    const core = new RejectingThenableCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "cmd", name: "fail", id: "thenable-fail", args: [] });

    await flush();
    await flush();

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "thenable-fail",
      error: expect.objectContaining({
        name: "Error",
        message: "thenable boom",
      }),
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
      error: {
        name: "RemoteShellProxyError",
        message: 'Command "nonExistent" is not declared in wcBindable.commands',
      },
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
      error: {
        name: "RemoteShellProxyError",
        message: 'Method "boom" not found on Core',
      },
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

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // _value is a private field, not declared in inputs
    handler!({ type: "set", name: "_value", value: "hacked" });
    expect((core as unknown as Record<string, unknown>)._value).not.toBe("hacked");
    expect(warnSpy).toHaveBeenCalledWith(
      'RemoteShellProxy: ignored set for undeclared input "_value"',
    );

    // url IS declared in inputs — should work
    handler!({ type: "set", name: "url", value: "/allowed" });
    expect(core.url).toBe("/allowed");

    warnSpy.mockRestore();
  });

  it("rejects acknowledged sets for undeclared inputs", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "missing", value: 1, id: "bad-set" });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "bad-set",
      error: {
        name: "RemoteShellProxyError",
        message: 'Input "missing" is not declared in wcBindable.inputs',
      },
    });
  });

  it("isolates setter exceptions so the message handler survives", () => {
    class ThrowingSetterCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        inputs: [{ name: "value" }],
      };
      set value(_v: unknown) {
        throw new Error("invalid");
      }
      get value(): unknown {
        return undefined;
      }
    }

    const core = new ThrowingSetterCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must not throw — the exception should be caught inside the handler.
    expect(() => handler!({ type: "set", name: "value", value: "bad" })).not.toThrow();

    // Developer-visible log captures the failure.
    expect(errorSpy).toHaveBeenCalled();
    const call = errorSpy.mock.calls[0];
    expect(String(call[0])).toContain("value");
    expect((call[1] as Error).message).toBe("invalid");

    // Handler still alive — subsequent sync request is processed.
    handler!({ type: "sync" });
    expect(send).toHaveBeenCalledWith({ type: "sync", values: {} });

    errorSpy.mockRestore();
  });

  it("returns throw for acknowledged sets whose setters throw", () => {
    class ThrowingSetterCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        inputs: [{ name: "value" }],
      };
      set value(_v: unknown) {
        throw new TypeError("invalid");
      }
      get value(): unknown {
        return undefined;
      }
    }

    const core = new ThrowingSetterCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    new RemoteShellProxy(core, server);
    handler!({ type: "set", name: "value", value: "bad", id: "set-throw" });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "set-throw",
      error: expect.objectContaining({
        name: "TypeError",
        message: "invalid",
      }),
    });
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
      error: expect.objectContaining({
        name: "Error",
        message: "something went wrong",
      }),
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
      error: expect.objectContaining({
        name: "Error",
        message: "sync error",
      }),
    });
  });

  it("serializes thrown Error objects with name, message, and stack", () => {
    class CustomRemoteError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomRemoteError";
      }
    }

    class ThrowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "boom" }],
      };
      boom(): never {
        throw new CustomRemoteError("structured failure");
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
    handler!({ type: "cmd", name: "boom", id: "structured", args: [] });

    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "structured",
      error: expect.objectContaining({
        name: "CustomRemoteError",
        message: "structured failure",
        stack: expect.any(String),
      }),
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

  it("drops inbound client messages after dispose()", () => {
    const core = new TestCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const shell = new RemoteShellProxy(core, server);
    shell.dispose();

    // set: Core must not be mutated via a post-dispose message.
    handler!({ type: "set", name: "url", value: "/should-not-apply" });
    expect(core.url).toBe("");

    // cmd: no response must be sent, and the method must not be invoked.
    const spy = vi.spyOn(core, "abort");
    handler!({ type: "cmd", name: "abort", id: "late", args: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    // sync: no response must be sent either.
    handler!({ type: "sync" });
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows async cmd resolution arriving after dispose()", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    class SlowCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "slow", async: true }],
      };
      slow(): Promise<unknown> {
        return new Promise((resolve) => { resolveFetch = resolve; });
      }
    }

    const core = new SlowCore();
    const send = vi.fn();
    let handler: ((msg: ClientMessage) => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const shell = new RemoteShellProxy(core, server);

    // Kick off an in-flight command.
    handler!({ type: "cmd", name: "slow", id: "99", args: [] });
    // Dispose before the command resolves.
    shell.dispose();
    // Now resolve the Promise — the `.then` must not send anything.
    resolveFetch!("too-late");
    await flush();
    await flush();

    expect(send).not.toHaveBeenCalled();
  });

  it("dispose() is idempotent", () => {
    const core = new TestCore();
    const server: ServerTransport = {
      send: () => {},
      onMessage: () => {},
    };
    const shell = new RemoteShellProxy(core, server);
    expect(() => {
      shell.dispose();
      shell.dispose();
    }).not.toThrow();
  });

  it("auto-disposes when the server transport closes", () => {
    const core = new TestCore();
    const send = vi.fn();
    let closeHandler: (() => void) | null = null;
    const server: ServerTransport = {
      send,
      onMessage: () => {},
      onClose: (handler) => { closeHandler = handler; },
    };

    new RemoteShellProxy(core, server);
    closeHandler!();

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
