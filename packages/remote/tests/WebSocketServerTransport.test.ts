import { describe, it, expect, vi } from "vitest";
import { WebSocketServerTransport } from "../src/index.js";
import { MockBrowserWebSocket } from "./_helpers.js";

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
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        if (type !== "message") return;
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
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        if (type !== "message") return;
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
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        if (type !== "message") return;
        listeners.push(listener);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    listeners[0](Buffer.from(JSON.stringify({ type: "set", name: "url", value: "/buffer" }), "utf8"));

    expect(onMessage).toHaveBeenCalledWith({ type: "set", name: "url", value: "/buffer" });
  });

  it("parses ArrayBuffer payloads from EventEmitter-style sockets", () => {
    const listeners: Array<(data: unknown) => void> = [];
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        if (type !== "message") return;
        listeners.push(listener);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "set", name: "url", value: "/array-buffer" }));
    listeners[0](bytes.buffer);

    expect(onMessage).toHaveBeenCalledWith({ type: "set", name: "url", value: "/array-buffer" });
  });

  it("parses Uint8Array payloads from standard sockets", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "sync" }));
    ws.emit("message", { data: bytes });

    expect(onMessage).toHaveBeenCalledWith({ type: "sync" });
  });

  it("ignores parsed client messages with invalid shape", () => {
    const listeners: Array<(data: unknown) => void> = [];
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        if (type !== "message") return;
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

  it("rejects cmd messages whose id is an empty string", () => {
    const listeners: Array<(data: unknown) => void> = [];
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        if (type !== "message") return;
        listeners.push(listener);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onMessage = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(onMessage);
    listeners[0](JSON.stringify({ type: "cmd", name: "doFetch", id: "", args: [] }));

    expect(onMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "WebSocketServerTransport: ignoring invalid client message",
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("accepts set messages without a value field as an undefined assignment", () => {
    // JSON.stringify drops `value: undefined`, so a client that calls
    // `set(name, undefined)` emits a `set` message with no `value` key.
    // The server must treat that as an undefined assignment rather than
    // discarding the message.
    const listeners: Array<(data: unknown) => void> = [];
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        if (type !== "message") return;
        listeners.push(listener);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    listeners[0](JSON.stringify({ type: "set", name: "url" }));

    expect(onMessage).toHaveBeenCalledWith({ type: "set", name: "url" });
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

  it("delivers close notification even when the socket closes before onClose registration", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const onClose = vi.fn();

    ws.emit("close");
    transport.onClose(onClose);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tracks early close events for EventEmitter-style sockets", () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: (...args: unknown[]) => void) => {
        const entries = listeners.get(type) ?? [];
        entries.push(listener);
        listeners.set(type, entries);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const onClose = vi.fn();

    for (const listener of listeners.get("close") ?? []) {
      listener();
    }
    transport.onClose(onClose);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("replaces a previously registered message handler on re-registration (addEventListener)", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const first = vi.fn();
    const second = vi.fn();

    transport.onMessage(first);
    transport.onMessage(second);
    ws.emit("message", { data: JSON.stringify({ type: "sync" }) });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("replaces a previously registered message handler on re-registration (EventEmitter)", () => {
    const listeners = new Map<string, Array<(data: unknown) => void>>();
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: (data: unknown) => void) => {
        const entries = listeners.get(type) ?? [];
        entries.push(listener);
        listeners.set(type, entries);
      },
    };
    const transport = new WebSocketServerTransport(ws);
    const first = vi.fn();
    const second = vi.fn();

    transport.onMessage(first);
    transport.onMessage(second);

    // Underlying socket should have been subscribed only once — the
    // implementation must not attach a second listener on re-registration.
    expect(listeners.get("message") ?? []).toHaveLength(1);
    expect(listeners.get("close") ?? []).toHaveLength(1);
    expect(listeners.get("error") ?? []).toHaveLength(1);
    listeners.get("message")?.[0](JSON.stringify({ type: "sync" }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("replaces a previously registered close handler on re-registration", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const first = vi.fn();
    const second = vi.fn();

    transport.onClose(first);
    transport.onClose(second);
    ws.emit("close");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("calls a re-registered close handler immediately after close already fired", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);
    const first = vi.fn();
    const second = vi.fn();

    transport.onClose(first);
    ws.emit("close");
    transport.onClose(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("dispose() removes WebSocket listeners for standard sockets", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketServerTransport(ws as unknown as Parameters<typeof WebSocketServerTransport>[0]);

    transport.onMessage(vi.fn());

    expect(ws.listenerCount("message")).toBe(1);
    expect(ws.listenerCount("close")).toBe(1);
    expect(ws.listenerCount("error")).toBe(1);

    transport.dispose();

    expect(ws.listenerCount("message")).toBe(0);
    expect(ws.listenerCount("close")).toBe(0);
    expect(ws.listenerCount("error")).toBe(0);
  });

  it("dispose() removes EventEmitter listeners", () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const ws = {
      send: vi.fn(),
      on: (type: "message" | "close" | "error", listener: (...args: unknown[]) => void) => {
        const entries = listeners.get(type) ?? [];
        entries.push(listener);
        listeners.set(type, entries);
      },
      off: (type: "message" | "close" | "error", listener: (...args: unknown[]) => void) => {
        const entries = listeners.get(type) ?? [];
        const kept = entries.filter((entry) => entry !== listener);
        if (kept.length > 0) listeners.set(type, kept);
        else listeners.delete(type);
      },
    };
    const transport = new WebSocketServerTransport(ws);

    transport.onMessage(vi.fn());

    expect(listeners.get("message") ?? []).toHaveLength(1);
    expect(listeners.get("close") ?? []).toHaveLength(1);
    expect(listeners.get("error") ?? []).toHaveLength(1);

    transport.dispose();

    expect(listeners.get("message") ?? []).toHaveLength(0);
    expect(listeners.get("close") ?? []).toHaveLength(0);
    expect(listeners.get("error") ?? []).toHaveLength(0);
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
