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
