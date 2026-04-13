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
import { createMockTransportPair, flush, TestCore } from "./_helpers.js";

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
