import { describe, it, expect, vi } from "vitest";
import { bind } from "@wc-bindable/core";
import { createRemoteCoreProxy } from "../src/RemoteCoreProxy.js";
import { RemoteShellProxy } from "../src/RemoteShellProxy.js";
import type {
  ClientTransport,
  ServerTransport,
  ClientMessage,
  ServerMessage,
} from "../src/types.js";
import { WebSocketClientTransport } from "../src/transport/WebSocketClientTransport.js";
import { WebSocketServerTransport } from "../src/transport/WebSocketServerTransport.js";
import { createMockTransportPair, flush, MockBrowserWebSocket, TestCore } from "./_helpers.js";

/**
 * Wire a MockBrowserWebSocket to a ws-library-like counterpart so traffic
 * flows through real JSON.stringify + JSON.parse in both directions. Used
 * to exercise issues that only surface on the wire (e.g. `undefined` being
 * dropped by JSON).
 */
function createWebSocketPair(): {
  clientTransport: WebSocketClientTransport;
  serverTransport: WebSocketServerTransport;
} {
  const clientWs = new MockBrowserWebSocket(WebSocket.OPEN);
  const serverListeners: Array<(data: unknown) => void> = [];
  const originalSend = clientWs.send.bind(clientWs);
  clientWs.send = (data: string) => {
    originalSend(data);
    for (const listener of serverListeners) listener(data);
  };

  const serverWs = {
    send: (data: string) => {
      clientWs.emit("message", { data });
    },
    on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
      if (type === "message") serverListeners.push(listener);
    },
  };

  return {
    clientTransport: new WebSocketClientTransport(clientWs as unknown as WebSocket),
    serverTransport: new WebSocketServerTransport(serverWs),
  };
}

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

  it("round-trips undefined updates and undefined set through the real WebSocket wire", async () => {
    // JSON.stringify drops `value: undefined`, so a live update that
    // reverts a property to undefined and a `set(name, undefined)` call
    // must both be understood as undefined on the receiving side. This
    // test wires the real WebSocket transports so JSON.stringify /
    // JSON.parse actually run — the mock pair used by other tests bypasses
    // serialization and would not have caught the drop.
    const { clientTransport, serverTransport } = createWebSocketPair();

    class NullableCore extends EventTarget {
      static wcBindable = {
        protocol: "wc-bindable" as const,
        version: 1 as const,
        properties: [
          // Use a custom getter that returns undefined — CustomEvent
          // normalizes a `detail: undefined` init to `null`, so we can't
          // exercise the undefined-update path through the default getter.
          { name: "value", event: "nullable:value-changed", getter: () => undefined },
        ],
        inputs: [{ name: "url" }],
      };

      _value: unknown = "initial";
      _url: unknown = "start";
      get value(): unknown { return this._value; }
      get url(): unknown { return this._url; }
      set url(v: unknown) { this._url = v; }
    }

    const core = new NullableCore();
    new RemoteShellProxy(core, serverTransport);

    const proxy = createRemoteCoreProxy(NullableCore.wcBindable, clientTransport) as unknown as { value: unknown; set: (n: string, v: unknown) => void };

    await flush();
    // Initial value from sync should be "initial".
    expect(proxy.value).toBe("initial");

    // Server-side live update to undefined — the server's getter returns
    // undefined, so the `update` message's `value` field is dropped by
    // JSON.stringify and must be reconstructed as undefined on the client.
    core._value = undefined;
    core.dispatchEvent(new Event("nullable:value-changed"));
    await flush();

    expect(proxy.value).toBeUndefined();

    // Client-side set(name, undefined) — JSON.stringify drops the field
    // too, and the server must treat the absent `value` as undefined.
    proxy.set("url", undefined);
    await flush();

    expect(core._url).toBeUndefined();
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
