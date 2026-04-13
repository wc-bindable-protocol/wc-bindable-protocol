import { describe, it, expect, vi } from "vitest";
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
  ServerMessage,
  ClientMessage,
} from "../src/types.js";
import { createSyncTransportPair, TestCore } from "./_helpers.js";

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

  it("allows reconnect() after a send failure on a transport without onClose", async () => {
    // Simulates a custom transport that signals closure only by throwing
    // from send(). Without onClose support the proxy must still clear its
    // internal transport on a send failure so reconnect() can attach a
    // replacement — otherwise the proxy would be permanently stuck.
    let failing = false;
    const failingClient: ClientTransport = {
      send: () => {
        if (failing) throw new Error("connection is closed");
      },
      onMessage: () => {},
      // Note: no onClose — this is the exact scenario the bug cares about.
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, failingClient);

    // Flip to failing after the initial sync; the next user-triggered send
    // should fail and clear the internal transport.
    failing = true;
    await expect(proxy.invoke("doFetch")).rejects.toThrow("connection is closed");

    // Subsequent calls keep rejecting while the proxy is disconnected.
    await expect(proxy.invoke("doFetch")).rejects.toThrow("connection is closed");

    // reconnect() must succeed — this was the bug: the proxy used to treat
    // itself as still connected and reject reconnect() outright.
    const sent: ClientMessage[] = [];
    const recoveredClient: ClientTransport = {
      send: (msg) => { sent.push(msg); },
      onMessage: () => {},
    };

    expect(() => (proxy as RemoteCoreProxy).reconnect(recoveredClient)).not.toThrow();

    // The freshly attached transport is used for later sends. invoke() on
    // the recovered transport stays pending (no response) — just confirm
    // the message was actually forwarded through the new transport.
    void proxy.invoke("doFetch");
    expect(sent.some((m) => m.type === "cmd" && m.name === "doFetch")).toBe(true);
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
