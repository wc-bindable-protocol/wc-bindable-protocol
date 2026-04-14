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
  RemoteSerializedError,
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

  it("routes initial sync send failures through the shared transport failure path", () => {
    const dispose = vi.fn();
    const client: ClientTransport = {
      send: () => {
        throw new Error("initial sync failed");
      },
      onMessage: () => {},
      dispose,
    };

    expect(() => createRemoteCoreProxy(TestCore.wcBindable, client)).toThrow("initial sync failed");
    expect(dispose).toHaveBeenCalledTimes(1);
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
        serverSend({ type: "sync", values: { value: "hello", loading: false }, capabilities: { setAck: true } });
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

  it("rejects pending setWithAck() once sync reveals a legacy server without ack capability", async () => {
    const send = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pending = proxy.setWithAck("url", "/api/legacy");

    handler!({ type: "sync", values: { value: "snapshot" } });

    await expect(pending).rejects.toThrow(/does not support setWithAck/);

    const pendingMap = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
    expect(pendingMap.size).toBe(0);
  });

  it("rejects setWithAck() immediately after sync established no ack capability", async () => {
    const send = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    handler!({ type: "sync", values: {}, capabilities: {} });

    await expect(proxy.setWithAck("url", "/api/legacy")).rejects.toThrow(/does not support setWithAck/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("setWithAck() rejects on throw response", async () => {
    const send = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const remoteError: RemoteSerializedError = { name: "TypeError", message: "invalid url" };
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
      error: remoteError,
    });

    const error = await pending.catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("invalid url");
    expect((error as Error & { cause?: unknown }).cause).toBe(remoteError);
  });

  it("rejects setWithAckOptions() immediately when the signal is already aborted", async () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };
    const controller = new AbortController();
    controller.abort();

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    await expect(proxy.setWithAckOptions("url", "/api/ack", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects setWithAckOptions() when aborted in flight and clears pending state", async () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };
    const controller = new AbortController();

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pendingSet = proxy.setWithAckOptions("url", "/api/ack", { signal: controller.signal });

    controller.abort();

    await expect(pendingSet).rejects.toMatchObject({ name: "AbortError" });

    const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
    expect(pending.size).toBe(0);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "set", name: "url", value: "/api/ack" }));
  });

  it("times out pending setWithAck() requests by default and clears pending state", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const client: ClientTransport = {
        send,
        onMessage: () => {},
      };

      const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
      const pendingSet = expect(proxy.setWithAck("url", "/api/ack")).rejects.toMatchObject({
        name: "TimeoutError",
        message: 'RemoteCoreProxy: setWithAck("url") timed out after 30000ms',
      });

      await vi.advanceTimersByTimeAsync(30_000);

      await pendingSet;

      const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
      expect(pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("rejects setWithAckOptions() for undeclared inputs without sending", async () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pending = proxy.setWithAckOptions("value", "nope", {});

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(
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

  it("validates command name on invoke() and rejects without sending", async () => {
    const send = vi.fn();
    const client: ClientTransport = {
      send,
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    await expect(proxy.invoke("missingCommand")).rejects.toThrow(
      'RemoteCoreProxy: command "missingCommand" is not declared in wcBindable.commands',
    );
    // the only send() that happened is the initial "sync"
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ type: "sync" });
  });

  it("validates command name on invoke() even after transport close or dispose", async () => {
    let closeHandler: (() => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: (h) => { closeHandler = h; },
    };

    const closedProxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    closeHandler!();
    await expect(closedProxy.invoke("typo")).rejects.toThrow(
      'RemoteCoreProxy: command "typo" is not declared in wcBindable.commands',
    );

    const disposedProxy = createRemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    });
    disposedProxy.dispose();
    await expect(disposedProxy.invoke("typo")).rejects.toThrow(
      'RemoteCoreProxy: command "typo" is not declared in wcBindable.commands',
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

  it("throws on direct assignment to declared non-input properties", () => {
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy & { value: unknown };

    expect(() => {
      proxy.value = "local";
    }).toThrow('RemoteCoreProxy: declared property "value" is read-only; only wcBindable.inputs are assignable');
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
    }).toThrow('RemoteCoreProxy: declared property "toString" is read-only; only wcBindable.inputs are assignable');
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

  it("falls back to incrementing command ids when crypto.randomUUID is unavailable", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const send = vi.fn();
    const client: ClientTransport = {
      send: (msg) => {
        send(msg);
        if (msg.type === "cmd") {
          handler!({ type: "return", id: msg.id, value: "fallback-id" });
        }
      },
      onMessage: (h) => { handler = h; },
    };
    const originalCrypto = globalThis.crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { ...originalCrypto, randomUUID: undefined },
    });

    try {
      const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
      await expect(proxy.invoke("doFetch")).resolves.toBe("fallback-id");
      expect(send).toHaveBeenCalledWith({ type: "cmd", name: "doFetch", id: "1", args: [] });
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
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

  it("revives serialized remote errors into Error instances", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const remoteError: RemoteSerializedError = {
      name: "CustomRemoteError",
      message: "structured failure",
      stack: "CustomRemoteError: structured failure\n    at remote:1:1",
      cause: { status: 422, field: "url" },
    };
    const client: ClientTransport = {
      send: (msg) => {
        if (msg.type === "cmd") {
          handler!({ type: "throw", id: msg.id, error: remoteError });
        }
      },
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const error = await proxy.invoke("doFetch").catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CustomRemoteError");
    expect(error.message).toBe("structured failure");
    expect(error.stack).toBe(remoteError.stack);
    expect((error as Error & { cause?: unknown }).cause).toBe(remoteError);
  });

  it("falls back to direct cause assignment when Object.defineProperty throws during error revival", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const remoteError: RemoteSerializedError = { name: "BrokenDefine", message: "fallback cause" };
    const client: ClientTransport = {
      send: (msg) => {
        if (msg.type === "cmd") {
          handler!({ type: "throw", id: msg.id, error: remoteError });
        }
      },
      onMessage: (h) => { handler = h; },
    };
    const definePropertySpy = vi.spyOn(Object, "defineProperty").mockImplementation(() => {
      throw new Error("defineProperty blocked");
    });

    try {
      const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
      const error = await proxy.invoke("doFetch").catch((err) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { cause?: unknown }).cause).toBe(remoteError);
    } finally {
      definePropertySpy.mockRestore();
    }
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

  it("allows symbol-keyed local assignments through the proxy target", () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy & Record<symbol, unknown>;
    const key = Symbol("local");

    proxy[key] = 123;

    expect(proxy[key]).toBe(123);
  });

  it("rejects undeclared string property assignments", () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy & { localOnly?: unknown };

    expect(() => {
      proxy.localOnly = 123;
    }).toThrow('RemoteCoreProxy: cannot assign to undeclared property "localOnly"');
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

  it("supports invokeWithOptions(name, args, options) to avoid options/args ambiguity", async () => {
    const send = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (next) => { handler = next; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pending = proxy.invokeWithOptions("doFetch", ["arg1", 2], { timeoutMs: 25 });

    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "cmd", name: "doFetch", args: ["arg1", 2] }),
    );

    const requestId = send.mock.calls.at(-1)?.[0]?.id as string;
    handler!({ type: "return", id: requestId, value: { ok: true } });

    await expect(pending).resolves.toEqual({ ok: true });
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

  it("uses timeoutMs from invokeWithOptions() and clears pending state on timeout", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const client: ClientTransport = {
        send,
        onMessage: () => {},
      };

      const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
      const pendingInvoke = expect(proxy.invokeWithOptions("doFetch", { timeoutMs: 25 })).rejects.toMatchObject({
        name: "TimeoutError",
        message: 'RemoteCoreProxy: invoke("doFetch") timed out after 25ms',
      });

      await vi.advanceTimersByTimeAsync(25);

      await pendingInvoke;

      const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
      expect(pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects (not throws) when timeoutMs is invalid", async () => {
    const client: ClientTransport = {
      send: vi.fn(),
      onMessage: () => {},
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    // invokeWithOptions and setWithAckOptions must surface invalid timeoutMs
    // as an async rejection — callers chain .catch() on the returned Promise
    // and would miss a synchronous throw.
    const invokePromise = proxy.invokeWithOptions("doFetch", { timeoutMs: -1 });
    expect(invokePromise).toBeInstanceOf(Promise);
    await expect(invokePromise).rejects.toBeInstanceOf(RangeError);

    const setPromise = proxy.setWithAckOptions("url", "x", { timeoutMs: Number.NaN });
    expect(setPromise).toBeInstanceOf(Promise);
    await expect(setPromise).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects only the pending setWithAck() when send() fails on a non-serializable payload", async () => {
    const send = vi.fn((msg: ClientMessage) => {
      JSON.stringify(msg);
    });
    const dispose = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (next) => { handler = next; },
      dispose,
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    const badPending = proxy.setWithAck("url", 1n);
    await expect(badPending).rejects.toBeInstanceOf(TypeError);

    const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
    expect(pending.size).toBe(0);
    expect(dispose).not.toHaveBeenCalled();

    const goodPending = proxy.setWithAck("url", "/ok");
    const requestId = send.mock.calls.at(-1)?.[0]?.id as string;
    handler!({ type: "return", id: requestId, value: undefined });

    await expect(goodPending).resolves.toBeUndefined();
  });

  it("rejects pending setWithAck() with a default transport-closed error when the transport disappears without a connection error", async () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy;

    Object.defineProperty(proxy, "_transport", { value: null, writable: true });
    Object.defineProperty(proxy, "_connectionError", { value: null, writable: true });

    await expect(proxy.setWithAck("url", "/api")).rejects.toThrow("Transport closed");
  });

  it("rejects invoke() with a default transport-closed error when the transport disappears without a connection error", async () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client) as RemoteCoreProxy;

    Object.defineProperty(proxy, "_transport", { value: null, writable: true });
    Object.defineProperty(proxy, "_connectionError", { value: null, writable: true });

    await expect(proxy.invoke("doFetch")).rejects.toThrow("Transport closed");
  });

  it("disconnects and rejects setWithAck() when sending a serializable payload throws", async () => {
    const dispose = vi.fn();
    const client: ClientTransport = {
      send: (msg) => {
        if (msg.type === "sync") return;
        throw new Error("socket blew up");
      },
      onMessage: () => {},
      dispose,
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    await expect(proxy.setWithAck("url", "/api")).rejects.toThrow("socket blew up");
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(proxy.invoke("doFetch")).rejects.toThrow("socket blew up");
  });

  it("throws from set() when sending a serializable payload fails", () => {
    const dispose = vi.fn();
    const client: ClientTransport = {
      send: (msg) => {
        if (msg.type === "sync") return;
        throw new Error("set send failed");
      },
      onMessage: () => {},
      dispose,
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    expect(() => proxy.set("url", "/api")).toThrow("set send failed");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects setWithAck() after dispose with the disposed error", async () => {
    const { client } = createSyncTransportPair();
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    proxy.dispose();

    await expect(proxy.setWithAck("url", "/api")).rejects.toThrow("RemoteCoreProxy disposed");
  });

  it("ignores late close callbacks after dispose", () => {
    let closeHandler: (() => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: (handler) => { closeHandler = handler; },
    };
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    proxy.dispose();

    expect(() => closeHandler!()).not.toThrow();
  });

  it("ignores stale onClose callbacks from a previous transport after reconnect", async () => {
    let firstCloseHandler: (() => void) | null = null;
    let secondHandler: ((msg: ServerMessage) => void) | null = null;
    const secondSend = vi.fn();
    const firstClient: ClientTransport = {
      send: () => {},
      onMessage: () => {},
      onClose: (handler) => { firstCloseHandler = handler; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, firstClient);
    firstCloseHandler!();
    proxy.reconnect({
      send: secondSend,
      onMessage: (handler) => { secondHandler = handler; },
    });

    expect(() => firstCloseHandler!()).not.toThrow();

    const pending = proxy.invoke("doFetch");
    const requestId = secondSend.mock.calls.at(-1)?.[0]?.id as string;
    secondHandler!({ type: "return", id: requestId, value: "fresh" });
    await expect(pending).resolves.toBe("fresh");
  });

  it("ignores late transport messages after dispose", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (next) => { handler = next; },
    };
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    proxy.dispose();

    expect(() => handler!({ type: "sync", values: { value: "ignored" } })).not.toThrow();
    expect((proxy as unknown as Record<string, unknown>).value).toBeUndefined();
  });

  it("direct raw proxy tolerates missing pending ids", () => {
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    }) as RemoteCoreProxy & { _rejectPendingRequest(id: string, error: unknown): void };

    expect(() => raw._rejectPendingRequest("missing", new Error("boom"))).not.toThrow();
  });

  it("direct raw proxy falls back to Transport closed in set() when no connection error is recorded", () => {
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    }) as RemoteCoreProxy & { _transport: ClientTransport | null; _connectionError: Error | null };

    raw._transport = null;
    raw._connectionError = null;

    expect(() => raw.set("url", "/api")).toThrow("Transport closed");
  });

  it("direct raw proxy skips optional transport disposal when dispose() is absent", () => {
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    }) as RemoteCoreProxy & { _disposeTransport(transport: ClientTransport | null): void };

    expect(() => raw._disposeTransport({ send: () => {}, onMessage: () => {} })).not.toThrow();
  });

  it("direct raw proxy ignores late messages after disposal", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: (next) => { handler = next; },
    }) as RemoteCoreProxy;

    raw.dispose();

    expect(() => handler!({ type: "sync", values: { value: "ignored" } })).not.toThrow();
  });

  it("direct raw proxy tolerates redundant abort callbacks after pending cleanup", async () => {
    let abortHandler: (() => void) | null = null;
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type: string, handler: () => void) => { abortHandler = handler; },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    });

    const pending = raw.setWithAckOptions("url", "/api", { signal });

    abortHandler!();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(() => abortHandler!()).not.toThrow();
  });

  it("direct raw proxy tolerates late timeout callbacks after pending cleanup", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      let handler: ((msg: ServerMessage) => void) | null = null;
      const send = vi.fn();
      const raw = new RemoteCoreProxy(TestCore.wcBindable, {
        send,
        onMessage: (next) => { handler = next; },
      });

      const pending = raw.setWithAckOptions("url", "/api", { timeoutMs: 10 });
      const requestId = send.mock.calls.at(-1)?.[0]?.id as string;

      handler!({ type: "return", id: requestId, value: undefined });
      await expect(pending).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(10);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("direct raw proxy ignores handleClose after disposal", () => {
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    }) as RemoteCoreProxy & { _handleClose(): void };

    raw.dispose();

    expect(() => raw._handleClose()).not.toThrow();
  });

  it("direct raw proxy leaves invoke pending entries alone when rejecting unsupported setAck", () => {
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    }) as RemoteCoreProxy & {
      _pending: Map<string, { kind: "set-ack" | "invoke"; cleanup: () => void; reject: (e: unknown) => void; resolve: (v: unknown) => void }>;
      _rejectUnsupportedSetAckPending(): void;
    };

    raw._pending.set("invoke-1", {
      kind: "invoke",
      cleanup: vi.fn(),
      reject: vi.fn(),
      resolve: vi.fn(),
    });

    raw._rejectUnsupportedSetAckPending();

    expect(raw._pending.has("invoke-1")).toBe(true);
  });

  it("direct raw proxy ignores handleMessage after disposal", () => {
    const raw = new RemoteCoreProxy(TestCore.wcBindable, {
      send: () => {},
      onMessage: () => {},
    }) as RemoteCoreProxy & { _handleMessage(msg: ServerMessage): void };

    raw.dispose();

    expect(() => raw._handleMessage({ type: "sync", values: { value: "ignored" } })).not.toThrow();
  });

  it("uses a DOMException AbortError fallback when an already-aborted signal has no reason", async () => {
    const client: ClientTransport = {
      send: vi.fn(),
      onMessage: () => {},
    };
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    await expect(proxy.setWithAckOptions("url", "/api", { signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("uses an Error AbortError fallback when DOMException is unavailable", async () => {
    const client: ClientTransport = {
      send: vi.fn(),
      onMessage: () => {},
    };
    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const originalDomException = globalThis.DOMException;

    (globalThis as { DOMException?: typeof DOMException }).DOMException = undefined;
    try {
      await expect(proxy.invokeWithOptions("doFetch", { signal })).rejects.toMatchObject({
        name: "AbortError",
        message: "This operation was aborted",
      });
    } finally {
      (globalThis as { DOMException?: typeof DOMException }).DOMException = originalDomException;
    }
  });

  it("disables pending timeouts when timeoutMs is zero", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      let handler: ((msg: ServerMessage) => void) | null = null;
      const client: ClientTransport = {
        send,
        onMessage: (h) => { handler = h; },
      };
      const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
      const pending = proxy.invokeWithOptions("doFetch", [], { timeoutMs: 0 });
      const requestId = send.mock.calls.at(-1)?.[0]?.id as string;

      await vi.advanceTimersByTimeAsync(60_000);
      handler!({ type: "return", id: requestId, value: "no-timeout" });

      await expect(pending).resolves.toBe("no-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects only the pending invoke() when send() fails on a non-serializable payload", async () => {
    const send = vi.fn((msg: ClientMessage) => {
      JSON.stringify(msg);
    });
    const dispose = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (next) => { handler = next; },
      dispose,
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);

    const badPending = proxy.invoke("doFetch", 1n);
    await expect(badPending).rejects.toBeInstanceOf(TypeError);

    const pending = Reflect.getOwnPropertyDescriptor(proxy, "_pending")?.value as Map<string, unknown>;
    expect(pending.size).toBe(0);
    expect(dispose).not.toHaveBeenCalled();

    const goodPending = proxy.invoke("doFetch", "/ok");
    const requestId = send.mock.calls.at(-1)?.[0]?.id as string;
    handler!({ type: "return", id: requestId, value: { ok: true } });

    await expect(goodPending).resolves.toEqual({ ok: true });
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

  it("keeps a late return from a closed transport from reviving a pre-reconnect invoke", async () => {
    let firstHandler: ((msg: ServerMessage) => void) | null = null;
    let firstCloseHandler: (() => void) | null = null;
    const firstSend = vi.fn();
    const firstClient: ClientTransport = {
      send: firstSend,
      onMessage: (handler) => { firstHandler = handler; },
      onClose: (handler) => { firstCloseHandler = handler; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, firstClient);
    const staleInvoke = proxy.invoke("doFetch");
    const staleRequestId = firstSend.mock.calls.at(-1)?.[0]?.id as string;

    firstCloseHandler!();
    await expect(staleInvoke).rejects.toThrow("Transport closed");

    let secondHandler: ((msg: ServerMessage) => void) | null = null;
    const secondSend = vi.fn();
    const secondClient: ClientTransport = {
      send: secondSend,
      onMessage: (handler) => { secondHandler = handler; },
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    proxy.reconnect(secondClient);

    // Late return from the first transport must be ignored after reconnect.
    firstHandler!({ type: "return", id: staleRequestId, value: "stale" });

    const freshInvoke = proxy.invoke("doFetch");
    const requestId = secondSend.mock.calls.at(-1)?.[0]?.id as string;
    secondHandler!({ type: "return", id: requestId, value: "fresh" });

    await expect(freshInvoke).resolves.toBe("fresh");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("ignores stale sync capabilities from a previous transport after reconnect", async () => {
    let firstHandler: ((msg: ServerMessage) => void) | null = null;
    let firstCloseHandler: (() => void) | null = null;
    const firstClient: ClientTransport = {
      send: () => {},
      onMessage: (handler) => { firstHandler = handler; },
      onClose: (handler) => { firstCloseHandler = handler; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, firstClient);
    firstCloseHandler!();

    let secondHandler: ((msg: ServerMessage) => void) | null = null;
    const secondSend = vi.fn();
    const secondClient: ClientTransport = {
      send: secondSend,
      onMessage: (handler) => { secondHandler = handler; },
    };

    proxy.reconnect(secondClient);

    // Late sync from the previous transport must be ignored completely.
    firstHandler!({ type: "sync", values: {}, capabilities: {} });

    const pending = proxy.setWithAck("url", "/after-reconnect");
    const requestId = secondSend.mock.calls.at(-1)?.[0]?.id as string;

    secondHandler!({
      type: "sync",
      values: { value: null, loading: false },
      capabilities: { setAck: true },
    });
    secondHandler!({ type: "return", id: requestId, value: undefined });

    await expect(pending).resolves.toBeUndefined();
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

  it("preserves cached properties omitted from sync because the server getter failed", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send: () => {},
      onMessage: (h) => { handler = h; },
    };

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const onUpdate = vi.fn();
    bind(proxy, onUpdate);

    handler!({ type: "sync", values: { value: "hello", loading: true } });
    expect((proxy as unknown as Record<string, unknown>).value).toBe("hello");
    expect((proxy as unknown as Record<string, unknown>).loading).toBe(true);

    onUpdate.mockClear();

    handler!({
      type: "sync",
      values: { loading: false },
      getterFailures: ["value"],
    });

    expect((proxy as unknown as Record<string, unknown>).value).toBe("hello");
    expect((proxy as unknown as Record<string, unknown>).loading).toBe(false);
    expect(onUpdate).not.toHaveBeenCalledWith("value", null);
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

  it("warns when a setWithAck() reply unexpectedly includes a return payload", async () => {
    const send = vi.fn();
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = {
      send,
      onMessage: (next) => { handler = next; },
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const proxy = createRemoteCoreProxy(TestCore.wcBindable, client);
    const pending = proxy.setWithAck("url", "/api/ack");
    const requestId = send.mock.calls.at(-1)?.[0]?.id as string;

    handler!({ type: "return", id: requestId, value: { unexpected: true } });

    await expect(pending).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      `RemoteCoreProxy: received return payload for setWithAck request id "${requestId}"; ignoring unexpected value`,
    );

    warnSpy.mockRestore();
  });

  it("rejects declarations whose property names collide with EventTarget/proxy members", () => {
    const { client } = createSyncTransportPair();
    const makeDecl = (name: string): WcBindableDeclaration => ({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name, event: "t:x" }],
    });

    for (const reserved of ["addEventListener", "removeEventListener", "dispatchEvent", "constructor"]) {
      expect(() => createRemoteCoreProxy(makeDecl(reserved), client)).toThrow(
        /collides with a reserved/,
      );
    }
  });

  it("rejects declarations whose input names collide with EventTarget/proxy members", () => {
    const { client } = createSyncTransportPair();
    const makeDecl = (name: string): WcBindableDeclaration => ({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "t:x" }],
      inputs: [{ name }],
    });

    for (const reserved of ["set", "reconnect", "dispose", "constructor"]) {
      expect(() => createRemoteCoreProxy(makeDecl(reserved), client)).toThrow(
        /collides with a reserved/,
      );
    }
  });

  it("rejects declarations whose command names collide with EventTarget/proxy members", () => {
    const { client } = createSyncTransportPair();
    const makeDecl = (name: string): WcBindableDeclaration => ({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "t:x" }],
      commands: [{ name }],
    });

    for (const reserved of ["invoke", "set", "reconnect", "dispose"]) {
      expect(() => createRemoteCoreProxy(makeDecl(reserved), client)).toThrow(
        /collides with a reserved/,
      );
    }
  });

  it("rejects declarations whose names are reserved on the wire protocol", () => {
    const { client } = createSyncTransportPair();

    const propDecl = (name: string): WcBindableDeclaration => ({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name, event: "t:x" }],
    });
    const inputDecl = (name: string): WcBindableDeclaration => ({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "t:x" }],
      inputs: [{ name }],
    });
    const cmdDecl = (name: string): WcBindableDeclaration => ({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "t:x" }],
      commands: [{ name }],
    });

    // Wire-reserved names ("__proto__", "prototype") aren't caught by the
    // EventTarget/proxy-member check but are dropped by messageValidation,
    // so they must fail fast at declaration time instead.
    for (const reserved of ["__proto__", "prototype"]) {
      expect(() => createRemoteCoreProxy(propDecl(reserved), client)).toThrow(
        /reserved on the wire protocol/,
      );
      expect(() => createRemoteCoreProxy(inputDecl(reserved), client)).toThrow(
        /reserved on the wire protocol/,
      );
      expect(() => createRemoteCoreProxy(cmdDecl(reserved), client)).toThrow(
        /reserved on the wire protocol/,
      );
    }
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

  describe("maxPendingInvocations", () => {
    it("rejects new invoke once pending reaches the limit", async () => {
      // Hanging transport: messages go out but no response ever comes back.
      const client: ClientTransport = {
        send: () => {},
        onMessage: () => {},
      };
      const proxy = createRemoteCoreProxy(TestCore.wcBindable, client, {
        maxPendingInvocations: 2,
      });

      const first = proxy.invoke("doFetch");
      const second = proxy.invoke("doFetch");
      // Third exceeds the limit — rejects synchronously via Promise executor.
      await expect(proxy.invoke("doFetch"))
        .rejects.toThrow(/pending invocations exceeded maxPendingInvocations=2/);

      // The first two remain pending (they will eventually time out, but the
      // important invariant here is that the limit blocked the third).
      expect(first).toBeInstanceOf(Promise);
      expect(second).toBeInstanceOf(Promise);
    });

    it("releases capacity when a pending invoke settles", async () => {
      // Transport that captures cmd ids so the test can echo returns.
      let clientHandler: ((msg: ServerMessage) => void) | null = null;
      const pending: string[] = [];
      const client: ClientTransport = {
        send: (msg) => {
          if (msg.type === "cmd") pending.push(msg.id);
        },
        onMessage: (h) => { clientHandler = h; },
      };
      const proxy = createRemoteCoreProxy(TestCore.wcBindable, client, {
        maxPendingInvocations: 1,
      });

      const first = proxy.invoke("doFetch");
      await expect(proxy.invoke("doFetch"))
        .rejects.toThrow(/maxPendingInvocations=1/);

      clientHandler!({ type: "return", id: pending[0]!, value: "ok" } as ServerMessage);
      await expect(first).resolves.toBe("ok");

      // Capacity is available again.
      expect(proxy.invoke("doFetch")).toBeInstanceOf(Promise);
    });

    it("rejects invalid limit values at construction", () => {
      const { client } = createSyncTransportPair();
      for (const bad of [0, -1, 1.5, NaN]) {
        expect(() => createRemoteCoreProxy(TestCore.wcBindable, client, {
          maxPendingInvocations: bad,
        })).toThrow(/maxPendingInvocations must be a positive integer/);
      }
    });
  });
});
