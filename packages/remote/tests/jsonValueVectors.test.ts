import { describe, it, expect, vi } from "vitest";
import { createRemoteCoreProxy } from "../src/RemoteCoreProxy.js";
import { RemoteShellProxy } from "../src/RemoteShellProxy.js";
import type { ClientMessage, ClientTransport, ServerMessage, ServerTransport } from "../src/types.js";
import { WebSocketClientTransport } from "../src/transport/WebSocketClientTransport.js";
import { WebSocketServerTransport } from "../src/transport/WebSocketServerTransport.js";
import { MockBrowserWebSocket, deliverSync, flush } from "./_helpers.js";

const silent = () => ({ warn: vi.fn(), error: vi.fn() });

const decl = {
  protocol: "wc-bindable" as const,
  version: 1 as const,
  properties: [{ name: "value", event: "test:value" }],
  inputs: [{ name: "x" }],
  commands: [{ name: "f" }],
};

type Caps = { setAck?: boolean };

function recordingClient(options: Record<string, unknown> = {}) {
  let handler: ((msg: ServerMessage) => void) | null = null;
  const sent: ClientMessage[] = [];
  const client: ClientTransport = {
    send: (msg) => { JSON.stringify(msg); sent.push(msg); },
    onMessage: (next) => { handler = next; },
  };
  const proxy = createRemoteCoreProxy(decl, client, { logger: silent(), ...options }) as ReturnType<typeof createRemoteCoreProxy> & { x: unknown };
  return {
    proxy,
    sent,
    sync: (capabilities: Caps = { setAck: true }) => deliverSync(handler, { capabilities }),
    handler: () => handler!,
  };
}

function recordingServer(core: EventTarget, options: Record<string, unknown> = {}) {
  let handler: ((msg: ClientMessage) => void) | null = null;
  const send = vi.fn((msg: ServerMessage) => { JSON.stringify(msg); });
  const server: ServerTransport = { send, onMessage: (next) => { handler = next; } };
  const logger = silent();
  new RemoteShellProxy(core, server, { logger, ...options });
  return { send, logger, deliver: (msg: unknown) => handler!(msg as ClientMessage) };
}

function wireWebSocketPair() {
  const clientWs = new MockBrowserWebSocket(WebSocket.OPEN);
  const serverListeners: Array<(data: unknown) => void> = [];
  const originalSend = clientWs.send.bind(clientWs);
  const upstream: string[] = [];
  clientWs.send = (data: string) => {
    originalSend(data);
    upstream.push(data);
    for (const listener of serverListeners) listener(data);
  };
  const serverWs = {
    send: (data: string) => { clientWs.emit("message", { data }); },
    on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
      if (type === "message") serverListeners.push(listener);
    },
  };
  return {
    upstream,
    /** Deliver a raw frame to the server side, as an older consumer would send it. */
    rawUpstream: (data: string) => { for (const listener of serverListeners) listener(data); },
    clientTransport: new WebSocketClientTransport(clientWs as unknown as WebSocket, { logger: silent() }),
    serverTransport: new WebSocketServerTransport(serverWs, { logger: silent() }),
  };
}

const INVALID = { code: "WC_BINDABLE_INVALID_JSON_VALUE" };
class SubArray extends Array<unknown> {}

describe("vector 7 additions — consumer-side JsonValue gate", () => {
  const rejected: [string, unknown][] = [
    ["{ a: undefined }", { a: undefined }],
    ["[undefined]", [undefined]],
    ["1n", 1n],
    ["Array subclass", SubArray.from([1])],
  ];
  for (const preSyncBehavior of ["eager", "queue"] as const) {
    for (const synced of [false, true]) {
      it(`rejects with INVALID_JSON_VALUE and sends nothing (${preSyncBehavior}, synced=${synced})`, async () => {
        const { proxy, sent, sync } = recordingClient({ preSyncBehavior });
        if (synced) sync();
        const before = sent.length;
        for (const [, value] of rejected) {
          expect(() => proxy.set("x", value)).toThrow(expect.objectContaining(INVALID));
          await expect(proxy.setWithAck("x", value)).rejects.toMatchObject(INVALID);
          await expect(proxy.invoke("f", value)).rejects.toMatchObject(INVALID);
        }
        expect(sent.length).toBe(before);
      });
    }
  }

  it("rejects through the Proxy set trap", () => {
    const { proxy, sent, sync } = recordingClient();
    sync();
    const before = sent.length;
    expect(() => { proxy.x = new Date(0); }).toThrow(expect.objectContaining(INVALID));
    expect(sent.length).toBe(before);
  });

  it("codes the consumer-side undeclared-name errors", async () => {
    const { proxy, sync } = recordingClient();
    sync();
    expect(() => proxy.set("nope", 1)).toThrow(expect.objectContaining({ code: "WC_BINDABLE_UNDECLARED_INPUT" }));
    await expect(proxy.setWithAck("nope", 1)).rejects.toMatchObject({ code: "WC_BINDABLE_UNDECLARED_INPUT" });
    await expect(proxy.invoke("nope")).rejects.toMatchObject({ code: "WC_BINDABLE_UNDECLARED_COMMAND" });
  });
});

describe("vector 40 — an undefined input value is rejected and never sent", () => {
  for (const preSyncBehavior of ["eager", "queue"] as const) {
    for (const synced of [false, true]) {
      it(`set / proxy.x throw, setWithAck rejects, no frames (${preSyncBehavior}, synced=${synced})`, async () => {
        const { proxy, sent, sync } = recordingClient({ preSyncBehavior });
        if (synced) sync();
        const before = sent.length;
        expect(() => proxy.set("x", undefined)).toThrow(expect.objectContaining(INVALID));
        expect(() => proxy.set("x", undefined)).toThrow(/assign null to reset the input/);
        expect(() => { proxy.x = undefined; }).toThrow(expect.objectContaining(INVALID));
        await expect(proxy.setWithAck("x", undefined)).rejects.toMatchObject(INVALID);
        await expect(proxy.setWithAckOptions("x", undefined, { timeoutMs: 0 })).rejects.toMatchObject(INVALID);
        expect(sent.length).toBe(before);
      });
    }
  }

  it("still applies name / dispose checks first", async () => {
    const { proxy, sync } = recordingClient();
    sync();
    expect(() => proxy.set("nope", undefined)).toThrow(expect.objectContaining({ code: "WC_BINDABLE_UNDECLARED_INPUT" }));
    await expect(proxy.setWithAck("nope", undefined)).rejects.toMatchObject({ code: "WC_BINDABLE_UNDECLARED_INPUT" });
    proxy.dispose();
    expect(() => proxy.set("x", undefined)).toThrow(expect.objectContaining({ code: "WC_BINDABLE_DISPOSED" }));
    await expect(proxy.setWithAck("x", undefined)).rejects.toMatchObject({ code: "WC_BINDABLE_DISPOSED" });
  });

  it("checks terminal before the value", async () => {
    let close: (() => void) | null = null;
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = { send: () => {}, onMessage: (h) => { handler = h; }, onClose: (h) => { close = h; } };
    const proxy = createRemoteCoreProxy(decl, client, { logger: silent() });
    deliverSync(handler, { capabilities: { setAck: false } });
    close!();
    expect(() => proxy.set("x", new Date(0))).toThrow(expect.objectContaining({ code: "WC_BINDABLE_TERMINAL_FAILURE" }));
    expect(() => proxy.set("x", undefined)).toThrow(expect.objectContaining({ code: "WC_BINDABLE_TERMINAL_FAILURE" }));
    await expect(proxy.setWithAck("x", new Date(0))).rejects.toMatchObject({ code: "WC_BINDABLE_TERMINAL_FAILURE" });
    await expect(proxy.setWithAck("x", undefined)).rejects.toMatchObject({ code: "WC_BINDABLE_TERMINAL_FAILURE" });
  });

  it("rejects an undefined command argument (it cannot be encoded in cmd.args)", async () => {
    const { proxy, sent, sync } = recordingClient();
    sync();
    const before = sent.length;
    await expect(proxy.invoke("f", undefined)).rejects.toMatchObject(INVALID);
    await expect(proxy.invoke("f", 1, undefined)).rejects.toMatchObject(INVALID);
    expect(sent.length).toBe(before);
  });

  it("the producer still applies the legacy encoding an older consumer sends (real wire)", async () => {
    class Core extends EventTarget {
      static wcBindable = decl;
      log: unknown[] = ["start"];
      get value() { return 1; }
      get x() { return this.log.at(-1); }
      set x(v: unknown) { this.log.push(v); }
      f() { return 1; }
    }
    const core = new Core();
    const { clientTransport, serverTransport, rawUpstream } = wireWebSocketPair();
    new RemoteShellProxy(core, serverTransport, { logger: silent() });
    createRemoteCoreProxy(decl, clientTransport, { logger: silent() });
    await flush();
    // What a pre-0.10 consumer put on the wire for set(name, undefined).
    rawUpstream(JSON.stringify({ type: "set", name: "x" }));
    rawUpstream(JSON.stringify({ type: "set", name: "x", value: "a" }));
    rawUpstream(JSON.stringify({ type: "set", name: "x" }));
    await flush();
    expect(core.log).toEqual(["start", undefined, "a", undefined]);
  });
});

describe("validate-and-copy — what is sent is what was validated", () => {
  it("a value mutated while queued pre-sync is sent as validated", async () => {
    const { proxy, sent, sync, handler } = recordingClient({ preSyncBehavior: "queue" });
    const value: Record<string, unknown> = { a: 1 };
    const args: unknown[] = [{ n: 1 }];
    const pendingSet = proxy.setWithAck("x", value);
    const pendingInvoke = proxy.invokeWithOptions("f", args);
    value.a = new Date(0);
    (args[0] as Record<string, unknown>).n = NaN;
    args.push(undefined);
    sync();
    const set = sent.find((m) => m.type === "set") as Extract<ClientMessage, { type: "set" }>;
    const cmd = sent.find((m) => m.type === "cmd") as Extract<ClientMessage, { type: "cmd" }>;
    expect(set.value).toEqual({ a: 1 });
    expect(cmd.args).toEqual([{ n: 1 }]);
    handler()({ type: "return", id: set.id!, value: undefined });
    handler()({ type: "return", id: cmd.id, value: 1 });
    await expect(pendingSet).resolves.toBeUndefined();
    await expect(pendingInvoke).resolves.toBe(1);
  });

  it("a Proxy whose get trap disagrees with its descriptors is sent as validated", () => {
    const { proxy, sent, sync } = recordingClient();
    sync();
    proxy.set("x", new Proxy({ a: 1 }, { get: () => new Date(0) }));
    expect(JSON.stringify((sent.at(-1) as { value: unknown }).value)).toBe('{"a":1}');
  });
});

describe("resource limits — maxDepth and the send-time serialization guard", () => {
  const nest = (n: number): unknown => { let v: unknown = 0; for (let i = 0; i < n; i++) v = [v]; return v; };

  it("rejects values deeper than maxDepth (default 256) as a resource limit", async () => {
    const { proxy, sent, sync } = recordingClient();
    sync();
    const before = sent.length;
    expect(() => proxy.set("x", nest(257))).toThrow(/exceeds maxDepth=256 \(resource limit\)/);
    await expect(proxy.setWithAck("x", nest(257))).rejects.toMatchObject(INVALID);
    await expect(proxy.invoke("f", nest(257))).rejects.toMatchObject(INVALID);
    expect(sent.length).toBe(before);
    proxy.set("x", nest(256));
    void proxy.invoke("f", nest(256));
    expect(sent.length).toBe(before + 2);
  });

  it("honors a configured maxDepth on both sides and validates the option", () => {
    const { proxy, sync } = recordingClient({ maxDepth: 2 });
    sync();
    expect(() => proxy.set("x", nest(3))).toThrow(/maxDepth=2/);
    expect(() => recordingClient({ maxDepth: 0 })).toThrow(/maxDepth/);
    expect(() => recordingClient({ maxDepth: 1.5 })).toThrow(/maxDepth/);
    expect(() => recordingClient({ maxDepth: Number.POSITIVE_INFINITY })).not.toThrow();
    class Core extends EventTarget { static wcBindable = decl; set x(_v: unknown) {} }
    expect(() => recordingServer(new Core(), { maxDepth: -1 })).toThrow(/maxDepth/);
  });

  it("a serialization failure at send rejects only that call and keeps the transport", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const sent: ClientMessage[] = [];
    const dispose = vi.fn();
    const client: ClientTransport = {
      send: (msg) => { JSON.stringify(msg); sent.push(msg); },
      onMessage: (h) => { handler = h; },
      dispose,
    };
    const proxy = createRemoteCoreProxy(decl, client, { logger: silent() });
    deliverSync(handler, { capabilities: { setAck: true } });
    const stackError = new RangeError("Maximum call stack size exceeded");
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw stackError; });
    let setError: unknown;
    let ackPending: Promise<void>;
    let invokePending: Promise<unknown>;
    try {
      try { proxy.set("x", 1); } catch (err) { setError = err; }
      ackPending = proxy.setWithAck("x", 1);
      invokePending = proxy.invoke("f", 1);
    } finally {
      spy.mockRestore();
    }
    expect(setError).toMatchObject({ code: "WC_BINDABLE_INVALID_JSON_VALUE", cause: stackError });
    await expect(ackPending!).rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_JSON_VALUE", message: expect.stringContaining("resource limit") });
    await expect(invokePending!).rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_JSON_VALUE" });
    expect(dispose).not.toHaveBeenCalled();
    const ok = proxy.setWithAck("x", 2);
    handler!({ type: "return", id: (sent.at(-1) as { id: string }).id, value: undefined });
    await expect(ok).resolves.toBeUndefined();
  });

  it("a serialization failure while draining the pre-sync queue rejects only that entry", async () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    let failNext = false;
    const client: ClientTransport = {
      send: (msg) => { if (failNext && msg.type !== "sync") { failNext = false; throw new RangeError("Maximum call stack size exceeded"); } JSON.stringify(msg); },
      onMessage: (h) => { handler = h; },
    };
    const proxy = createRemoteCoreProxy(decl, client, { logger: silent(), preSyncBehavior: "queue" });
    const first = proxy.setWithAck("x", 1);
    const second = proxy.invoke("f");
    failNext = true;
    const spy = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new RangeError("Maximum call stack size exceeded"); });
    try {
      deliverSync(handler, { capabilities: { setAck: true } });
    } finally {
      spy.mockRestore();
    }
    await expect(first).rejects.toMatchObject(INVALID);
    expect(proxy.invoke).toBeDefined();
    void second;
  });
});

describe("vector 30(h) — producer code reaches err.code", () => {
  it("surfaces the throw envelope's code on the rejection", async () => {
    const { proxy, sent, sync, handler } = recordingClient();
    sync();
    const pending = proxy.setWithAck("x", 1);
    const id = (sent.at(-1) as { id: string }).id;
    handler()({ type: "throw", id, error: { name: "RemoteShellProxyError", message: "m", code: "WC_BINDABLE_PROTOCOL_ERROR" } });
    await expect(pending).rejects.toMatchObject({ code: "WC_BINDABLE_PROTOCOL_ERROR", cause: { code: "WC_BINDABLE_PROTOCOL_ERROR" } });
  });

  it("passes shell-synthesized and application codes end to end", async () => {
    class AppError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
    class Core extends EventTarget {
      static wcBindable = { ...decl, commands: ["f", "date", "app", "spoof", "spoofCause", "plainSpoof"].map((name) => ({ name })) };
      get value() { return 1; }
      set x(_v: unknown) { /* accepted */ }
      date() { return new Date(0); }
      app() { throw new AppError("MYAPP_FAILED"); }
      spoof() { throw new AppError("wc_bindable_timeout"); }
      spoofCause() { const e = new AppError("WC_BINDABLE_DISPOSED") as Error & { cause?: unknown }; e.cause = { detail: 1 }; throw e; }
      plainSpoof() { throw { name: "AppError", message: "obj", code: "WC_BINDABLE_DISPOSED" }; }
    }
    const clientDecl = { ...Core.wcBindable, inputs: [{ name: "x" }, { name: "extra" }] };
    const { clientTransport, serverTransport } = wireWebSocketPair();
    new RemoteShellProxy(new Core(), serverTransport, { logger: silent() });
    const proxy = createRemoteCoreProxy(clientDecl, clientTransport, { logger: silent() });
    await flush();
    await expect(proxy.setWithAck("extra", 1)).rejects.toMatchObject({ code: "WC_BINDABLE_UNDECLARED_INPUT" });
    await expect(proxy.invoke("date")).rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_RETURN_VALUE" });
    await expect(proxy.invoke("app")).rejects.toMatchObject({ code: "MYAPP_FAILED" });
    // An application code in the reserved namespace becomes REMOTE_THROW; the
    // original is not kept anywhere in the envelope.
    const spoof = await proxy.invoke("spoof").catch((e: unknown) => e) as Error & { code?: string };
    expect(spoof.code).toBe("WC_BINDABLE_REMOTE_THROW");
    // The envelope (exposed as err.cause) carries the replaced code and no
    // nested copy of the original one.
    expect(spoof).toMatchObject({ cause: { code: "WC_BINDABLE_REMOTE_THROW" } });
    expect((spoof as { cause?: { cause?: unknown } }).cause?.cause).toBeUndefined();
    await expect(proxy.invoke("spoofCause")).rejects.toMatchObject({
      code: "WC_BINDABLE_REMOTE_THROW",
      cause: { code: "WC_BINDABLE_REMOTE_THROW", cause: { detail: 1 } },
    });
    // A thrown plain object cannot set error.code at all: it is canonicalized.
    const plain = await proxy.invoke("plainSpoof").catch((e: unknown) => e) as Error & { code?: string };
    expect(plain).toBeInstanceOf(Error);
    expect(plain.name).toBe("NonErrorThrow");
    expect(plain.code).toBeUndefined();
  });

  it("does not surface a consumer-only code that arrives in a throw envelope", async () => {
    // An older producer forwarded thrown objects as-is, so the envelope could
    // carry any code. Codes reserved for consumer-side synthesis never come
    // from a producer legitimately.
    for (const code of ["WC_BINDABLE_DISPOSED", "WC_BINDABLE_TERMINAL_FAILURE", "WC_BINDABLE_TIMEOUT"]) {
      const { proxy, sent, sync, handler } = recordingClient();
      sync();
      const pending = proxy.invoke("f");
      const id = (sent.at(-1) as { id: string }).id;
      handler()({ type: "throw", id, error: { name: "AppError", message: "m", code } });
      await expect(pending).rejects.toMatchObject({ code: "WC_BINDABLE_REMOTE_THROW", cause: { code } });
    }
  });
});

describe("throw envelope hardening", () => {
  class Core extends EventTarget {
    static wcBindable = { protocol: "wc-bindable" as const, version: 1 as const, properties: [], commands: [{ name: "hostileCode" }, { name: "bigName" }, { name: "nonError" }, { name: "hostileFields" }] };
    hostileCode() { const e = new Error("h"); Object.defineProperty(e, "code", { get() { throw new Error("trap"); } }); throw e; }
    bigName() { const e = new Error("b"); (e as { name: unknown }).name = 1n; throw e; }
    nonError() { throw { name: "X", message: "m", when: new Date(0) }; }
    hostileFields() {
      const e = new Error("unused");
      for (const key of ["name", "message", "stack", "cause"]) {
        Object.defineProperty(e, key, { get() { throw new Error("trap"); } });
      }
      throw e;
    }
  }

  it("ignores a code getter that throws", () => {
    const { send, deliver } = recordingServer(new Core());
    deliver({ type: "cmd", name: "hostileCode", id: "h", args: [] });
    const error = (send.mock.calls[0][0] as { error: Record<string, unknown> }).error;
    expect(error).toMatchObject({ name: "Error", message: "h" });
    expect(error).not.toHaveProperty("code");
  });

  it("stringifies a non-string error name safely", () => {
    const { send, deliver } = recordingServer(new Core());
    deliver({ type: "cmd", name: "bigName", id: "b", args: [] });
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "b",
      error: expect.objectContaining({ name: "1", message: "b" }),
    });
  });

  it("reads name / message / stack / cause defensively (hostile getters fall back or are omitted)", () => {
    const { send, deliver } = recordingServer(new Core());
    deliver({ type: "cmd", name: "hostileFields", id: "hf", args: [] });
    expect(send).toHaveBeenCalledWith({ type: "throw", id: "hf", error: { name: "Error", message: "" } });
  });

  it("canonicalizes a non-Error thrown value; a non-JsonValue cause is omitted, never coerced", () => {
    const { send, deliver } = recordingServer(new Core());
    deliver({ type: "cmd", name: "nonError", id: "n", args: [] });
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "n",
      error: { name: "NonErrorThrow", message: "[object Object]" },
    });
  });

  it("wraps a non-Error send failure as the serialization cause", () => {
    let handler: ((msg: ServerMessage) => void) | null = null;
    const client: ClientTransport = { send: (msg) => { if (msg.type === "set") throw "not an Error"; }, onMessage: (h) => { handler = h; } };
    const proxy = createRemoteCoreProxy(decl, client, { logger: silent() });
    deliverSync(handler, { capabilities: { setAck: true } });
    const spy = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new RangeError("Maximum call stack size exceeded"); });
    try {
      expect(() => proxy.set("x", 1)).toThrow(/not an Error/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("vector 41 — producer-side malformed / invalid inbound", () => {
  class Core extends EventTarget {
    static wcBindable = { ...decl, commands: [{ name: "f" }] };
    applied: unknown[] = [];
    accessorReads = 0;
    get value() { return 1; }
    set x(v: unknown) { this.applied.push(v); }
    get f() { this.accessorReads++; return () => 1; }
  }

  it("applies the legacy encodings of set(name, undefined) without advertising any capability for them", () => {
    const core = new Core();
    const { send, deliver } = recordingServer(core);
    deliver({ type: "sync" });
    const sync = send.mock.calls[0][0] as { capabilities: Record<string, unknown> };
    expect(Object.keys(sync.capabilities).sort()).toEqual(["getterFailures", "setAck", "undefinedProperties"]);
    deliver({ type: "set", name: "x" }); // JSON transport: key absent
    deliver({ type: "set", name: "x", id: "a" });
    deliver({ type: "set", name: "x", value: undefined, id: "b" }); // by-reference transport: key present
    expect(core.applied).toEqual([undefined, undefined, undefined]);
    expect(send).toHaveBeenCalledWith({ type: "return", id: "a", value: undefined });
    expect(send).toHaveBeenLastCalledWith({ type: "return", id: "b", value: undefined });
  });

  it.each([
    ["set", { type: "set", name: "x", value: 1, id: "" }],
    ["value-less set", { type: "set", name: "x", id: "" }],
    ["undeclared set", { type: "set", name: "nope", value: 1, id: "" }],
    ["invalid set", { type: "set", name: "x", value: new Date(0), id: "" }],
    ["cmd", { type: "cmd", name: "f", id: "", args: [] }],
    ["undeclared cmd", { type: "cmd", name: "nope", id: "", args: [] }],
    ["cmd with a non-string id", { type: "cmd", name: "f", id: 7, args: [] }],
  ])("an empty or non-string id is logged and dropped before the Core is touched (%s)", (_label, msg) => {
    const core = new Core();
    const { send, logger, deliver } = recordingServer(core);
    deliver(msg);
    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("malformed id"));
    expect(core.applied).toEqual([]);
    expect(core.accessorReads).toBe(0);
  });

  it("an inbound non-JsonValue is rejected before the Core is touched", () => {
    const core = new Core();
    const { send, logger, deliver } = recordingServer(core);
    deliver({ type: "set", name: "x", value: { when: new Date(0) }, id: "b" });
    deliver({ type: "set", name: "x", value: new Date(0) });
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "b",
      error: expect.objectContaining({ code: "WC_BINDABLE_INVALID_JSON_VALUE" }),
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("is Date"));
    expect(core.applied).toEqual([]);
  });

  it("invalid cmd.args are rejected before the method is looked up", () => {
    const core = new Core();
    const { send, deliver } = recordingServer(core);
    deliver({ type: "cmd", name: "f", id: "c", args: [1, undefined] });
    deliver({ type: "cmd", name: "f", id: "d", args: { 0: 1 } });
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "c",
      error: expect.objectContaining({ code: "WC_BINDABLE_INVALID_JSON_VALUE" }),
    });
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "d",
      error: expect.objectContaining({ code: "WC_BINDABLE_PROTOCOL_ERROR" }),
    });
    expect(core.accessorReads).toBe(0);
  });

  it("does not depth-limit inbound values (the sender's limit is not negotiated)", () => {
    const core = new Core();
    const { send, deliver } = recordingServer(core, { maxDepth: 2 });
    deliver({ type: "set", name: "x", value: [[[0]]], id: "deep" });
    deliver({ type: "cmd", name: "f", id: "deepArgs", args: [[[[0]]]] });
    expect(core.applied).toEqual([[[[0]]]]);
    expect(send).toHaveBeenCalledWith({ type: "return", id: "deep", value: undefined });
    expect(send).toHaveBeenCalledWith({ type: "return", id: "deepArgs", value: 1 });
  });

  it("applies maxDepth to what it sends (return values)", () => {
    class Deep extends EventTarget {
      static wcBindable = { protocol: "wc-bindable" as const, version: 1 as const, properties: [], commands: [{ name: "deep" }] };
      deep() { return [[[0]]]; }
    }
    const { send, deliver } = recordingServer(new Deep(), { maxDepth: 2 });
    deliver({ type: "cmd", name: "deep", id: "d", args: [] });
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "d",
      error: expect.objectContaining({ code: "WC_BINDABLE_INVALID_RETURN_VALUE", message: expect.stringContaining("resource limit") }),
    });
  });
});

describe("vector 42 — commands are applied with the given arguments and their result propagated", () => {
  class Core extends EventTarget {
    static wcBindable = {
      protocol: "wc-bindable" as const,
      version: 1 as const,
      properties: [],
      commands: ["zero", "two", "thenable", "none", "nil", "date", "big", "cycle", "asyncDate", "liar"].map((name) => ({ name })),
    };
    calls: { name: string; argc: number; self: boolean }[] = [];
    zero() { this.calls.push({ name: "zero", argc: arguments.length, self: this === core }); }
    two(_a: unknown, _b: unknown) { this.calls.push({ name: "two", argc: arguments.length, self: this === core }); }
    thenable() { return { then: (resolve: (v: unknown) => void) => resolve({ via: "thenable" }) }; }
    none() { return undefined; }
    nil() { return null; }
    date() { return new Date(0); }
    big() { return 1n; }
    cycle() { const o: Record<string, unknown> = {}; o.self = o; return o; }
    async asyncDate() { return new Date(0); }
    liar() { return new Proxy({ a: 1 }, { get: () => new Date(0) }); }
  }
  const core = new Core();

  it("passes the argument count through and calls with this = core", () => {
    const { deliver } = recordingServer(core);
    deliver({ type: "cmd", name: "zero", id: "1", args: [1] });
    deliver({ type: "cmd", name: "two", id: "2", args: [1] });
    expect(core.calls).toEqual([
      { name: "zero", argc: 1, self: true },
      { name: "two", argc: 1, self: true },
    ]);
  });

  it("adopts thenables and distinguishes undefined from null", async () => {
    const { send, deliver } = recordingServer(core);
    deliver({ type: "cmd", name: "thenable", id: "t", args: [] });
    deliver({ type: "cmd", name: "none", id: "u", args: [] });
    deliver({ type: "cmd", name: "nil", id: "n", args: [] });
    await flush();
    expect(send).toHaveBeenCalledWith({ type: "return", id: "t", value: { via: "thenable" } });
    expect(send).toHaveBeenCalledWith({ type: "return", id: "u", value: undefined });
    expect(send).toHaveBeenCalledWith({ type: "return", id: "n", value: null });
  });

  it.each(["date", "big", "cycle", "asyncDate"])("a non-JsonValue return from %s becomes INVALID_RETURN_VALUE", async (name) => {
    const { send, deliver } = recordingServer(core);
    deliver({ type: "cmd", name, id: name, args: [] });
    await flush();
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: name,
      error: expect.objectContaining({ code: "WC_BINDABLE_INVALID_RETURN_VALUE" }),
    });
  });

  it("sends the validated copy of a return value", () => {
    const { send, deliver } = recordingServer(core);
    deliver({ type: "cmd", name: "liar", id: "l", args: [] });
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).toBe('{"type":"return","id":"l","value":{"a":1}}');
  });
});

describe("vector 43 — non-JsonValue outputs are dropped, never coerced", () => {
  class Core extends EventTarget {
    static wcBindable = {
      protocol: "wc-bindable" as const,
      version: 1 as const,
      properties: [{ name: "when", event: "c:when" }, { name: "ok", event: "c:ok" }],
    };
    when: unknown = new Date(0);
    ok: unknown = 1;
  }

  it("drops a non-JsonValue sync value into getterFailures with a warning", () => {
    const core = new Core();
    const { send, logger, deliver } = recordingServer(core);
    deliver({ type: "sync" });
    const sync = send.mock.calls[0][0] as Extract<ServerMessage, { type: "sync" }>;
    expect(sync.values).toEqual({ ok: 1 });
    expect(sync.getterFailures).toEqual(["when"]);
    expect(sync.undefinedProperties).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dropped sync value for "when"'));
  });

  it("drops a non-JsonValue update with a warning and sends a validated copy otherwise", () => {
    const core = new Core();
    const { send, logger } = recordingServer(core);
    core.dispatchEvent(new CustomEvent("c:when", { detail: new Date(0) }));
    core.dispatchEvent(new CustomEvent("c:when", { detail: { n: NaN } }));
    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    core.dispatchEvent(new CustomEvent("c:when", { detail: new Proxy({ a: 1 }, { get: () => new Date(0) }) }));
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).toBe('{"type":"update","name":"when","value":{"a":1}}');
  });

  it("the consumer keeps its last value when the producer drops a sync value or an update", async () => {
    const core = new Core();
    core.when = "first";
    const { clientTransport, serverTransport } = wireWebSocketPair();
    new RemoteShellProxy(core, serverTransport, { logger: silent() });
    const proxy = createRemoteCoreProxy(Core.wcBindable, clientTransport, { logger: silent() }) as unknown as Record<string, unknown> & { reconnect(t: ClientTransport): void };
    await flush();
    expect(proxy.when).toBe("first");
    core.dispatchEvent(new CustomEvent("c:when", { detail: new Date(0) }));
    await flush();
    expect(proxy.when).toBe("first");
    expect("when" in proxy).toBe(true);
  });
});

describe("throw envelope hardening — hostile thrown values", () => {
  it("treats a thrown Proxy whose prototype trap throws as a non-Error value", () => {
    class Core extends EventTarget {
      static wcBindable = { protocol: "wc-bindable" as const, version: 1 as const, properties: [], commands: [{ name: "f" }] };
      f() { throw new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } }); }
    }
    const { send, deliver } = recordingServer(new Core());
    deliver({ type: "cmd", name: "f", id: "p", args: [] });
    expect(send).toHaveBeenCalledWith({
      type: "throw",
      id: "p",
      error: expect.objectContaining({ name: "NonErrorThrow" }),
    });
  });
});
