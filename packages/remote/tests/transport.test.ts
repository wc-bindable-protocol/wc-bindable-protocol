import { describe, it, expect, vi } from "vitest";
import { WebSocketClientTransport } from "../src/transport/WebSocketClientTransport.js";
import { WebSocketServerTransport } from "../src/transport/WebSocketServerTransport.js";
import type { WebSocketLike } from "../src/transport/WebSocketServerTransport.js";
import type { ClientMessage, ServerMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock WebSocket for client-side tests
// ---------------------------------------------------------------------------

function createMockWebSocket(readyState: number = 0 /* CONNECTING */): {
  ws: WebSocket;
  fire: (type: string, data?: unknown) => void;
} {
  const listeners = new Map<string, Array<{ fn: EventListenerOrEventListenerObject; once: boolean }>>();

  const ws = {
    readyState,
    send: vi.fn(),
    addEventListener: vi.fn((type: string, fn: EventListenerOrEventListenerObject, opts?: { once?: boolean }) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push({ fn, once: !!opts?.once });
    }),
    removeEventListener: vi.fn(),
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  } as unknown as WebSocket;

  // Also set static constants (used in constructor checks).
  (globalThis as unknown as { WebSocket: { OPEN: number; CLOSING: number; CLOSED: number } }).WebSocket = {
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  } as unknown as typeof WebSocket;

  const fire = (type: string, data?: unknown) => {
    const entries = listeners.get(type) ?? [];
    const toRemove: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { fn, once } = entries[i];
      if (typeof fn === "function") {
        fn({ data, type } as unknown as Event);
      }
      if (once) toRemove.push(i);
    }
    for (let i = toRemove.length - 1; i >= 0; i--) {
      entries.splice(toRemove[i], 1);
    }
  };

  return { ws, fire };
}

// ---------------------------------------------------------------------------
// WebSocketClientTransport
// ---------------------------------------------------------------------------

describe("WebSocketClientTransport", () => {
  it("sends immediately when WebSocket is OPEN", () => {
    const { ws } = createMockWebSocket(1 /* OPEN */);
    const transport = new WebSocketClientTransport(ws);
    const msg: ClientMessage = { type: "sync" };

    transport.send(msg);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it("buffers messages when CONNECTING and flushes on open", () => {
    const { ws, fire } = createMockWebSocket(0 /* CONNECTING */);
    const transport = new WebSocketClientTransport(ws);
    const msg1: ClientMessage = { type: "sync" };
    const msg2: ClientMessage = { type: "set", name: "url", value: "/api" };

    transport.send(msg1);
    transport.send(msg2);

    // Not sent yet.
    expect(ws.send).not.toHaveBeenCalled();

    // Fire open.
    fire("open");

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg1));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg2));
  });

  it("throws on send after close during CONNECTING", () => {
    const { ws, fire } = createMockWebSocket(0);
    const transport = new WebSocketClientTransport(ws);

    fire("close");

    expect(() => transport.send({ type: "sync" })).toThrow("connection is closed");
  });

  it("throws on send after error during CONNECTING", () => {
    const { ws, fire } = createMockWebSocket(0);
    const transport = new WebSocketClientTransport(ws);

    fire("error");

    expect(() => transport.send({ type: "sync" })).toThrow("connection is closed");
  });

  it("marks as closed when constructed with CLOSED readyState", () => {
    const { ws } = createMockWebSocket(3 /* CLOSED */);
    const transport = new WebSocketClientTransport(ws);

    expect(() => transport.send({ type: "sync" })).toThrow("connection is closed");
  });

  it("marks as closed when constructed with CLOSING readyState", () => {
    const { ws } = createMockWebSocket(2 /* CLOSING */);
    const transport = new WebSocketClientTransport(ws);

    expect(() => transport.send({ type: "sync" })).toThrow("connection is closed");
  });

  it("delivers parsed server messages via onMessage", () => {
    const { ws, fire } = createMockWebSocket(1);
    const transport = new WebSocketClientTransport(ws);
    const handler = vi.fn();

    transport.onMessage(handler);
    const msg: ServerMessage = { type: "sync", values: { value: 42 } };
    fire("message", JSON.stringify(msg));

    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("ignores invalid server messages and warns instead of throwing", () => {
    const { ws, fire } = createMockWebSocket(1);
    const transport = new WebSocketClientTransport(ws);
    const handler = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(handler);

    expect(() => fire("message", "not json")).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "WebSocketClientTransport: ignoring invalid server message",
      expect.any(SyntaxError),
    );

    warn.mockRestore();
  });

  it("rejects server update messages with empty or reserved names", () => {
    const { ws, fire } = createMockWebSocket(1);
    const transport = new WebSocketClientTransport(ws);
    const handler = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(handler);

    fire("message", JSON.stringify({ type: "update", name: "" }));
    fire("message", JSON.stringify({ type: "update", name: "__proto__" }));
    fire(
      "message",
      '{"type":"sync","values":{"__proto__":{"polluted":true}}}',
    );

    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "WebSocketClientTransport: ignoring invalid server message",
      expect.any(Error),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "WebSocketClientTransport: ignoring invalid server message",
      expect.any(Error),
    );
    expect(warn).toHaveBeenNthCalledWith(
      3,
      "WebSocketClientTransport: ignoring invalid server message",
      expect.any(Error),
    );
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();

    warn.mockRestore();
  });

  it("onClose fires on close event", () => {
    const { ws, fire } = createMockWebSocket(1);
    const transport = new WebSocketClientTransport(ws);
    const handler = vi.fn();

    transport.onClose(handler);
    fire("close");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onClose fires on error event", () => {
    const { ws, fire } = createMockWebSocket(1);
    const transport = new WebSocketClientTransport(ws);
    const handler = vi.fn();

    transport.onClose(handler);
    fire("error");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("onClose fires only once when both close and error fire", () => {
    const { ws, fire } = createMockWebSocket(1);
    const transport = new WebSocketClientTransport(ws);
    const handler = vi.fn();

    transport.onClose(handler);
    fire("close");
    fire("error");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replaces onClose listeners by removing the previous socket listeners", () => {
    const { ws } = createMockWebSocket(1);
    const transport = new WebSocketClientTransport(ws);

    transport.onClose(() => {});
    transport.onClose(() => {});

    expect(ws.removeEventListener).toHaveBeenCalledWith("close", expect.any(Function));
    expect(ws.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("dispose() removes registered socket listeners and is idempotent", () => {
    const { ws } = createMockWebSocket(0);
    const transport = new WebSocketClientTransport(ws);

    transport.onMessage(() => {});
    transport.onClose(() => {});
    transport.dispose();
    transport.dispose();

    expect(ws.removeEventListener).toHaveBeenCalledWith("open", expect.any(Function));
    expect(ws.removeEventListener).toHaveBeenCalledWith("close", expect.any(Function));
    expect(ws.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(ws.removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// WebSocketServerTransport
// ---------------------------------------------------------------------------

describe("WebSocketServerTransport", () => {
  it("sends JSON-stringified messages via ws.send", () => {
    const ws: WebSocketLike = {
      send: vi.fn(),
      addEventListener: vi.fn(),
    };
    const transport = new WebSocketServerTransport(ws);
    const msg: ServerMessage = { type: "update", name: "v", value: 42 };

    transport.send(msg);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  it("receives messages via addEventListener (standard API)", () => {
    let listener: ((event: { data: unknown }) => void) | null = null;
    const ws: WebSocketLike = {
      send: vi.fn(),
      addEventListener: vi.fn((_type: string, fn: (event: { data: unknown }) => void) => {
        listener = fn;
      }),
    };
    const transport = new WebSocketServerTransport(ws);
    const handler = vi.fn();

    transport.onMessage(handler);
    const msg: ClientMessage = { type: "sync" };
    listener!({ data: JSON.stringify(msg) });

    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("ignores invalid addEventListener payloads and warns instead of throwing", () => {
    let listener: ((event: { data: unknown }) => void) | null = null;
    const ws: WebSocketLike = {
      send: vi.fn(),
      addEventListener: vi.fn((_type: string, fn: (event: { data: unknown }) => void) => {
        listener = fn;
      }),
    };
    const transport = new WebSocketServerTransport(ws);
    const handler = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(handler);

    expect(() => listener!({ data: "not json" })).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "WebSocketServerTransport: ignoring invalid client message",
      expect.any(SyntaxError),
    );

    warn.mockRestore();
  });

  it("rejects addEventListener client messages with empty or reserved names", () => {
    let listener: ((event: { data: unknown }) => void) | null = null;
    const ws: WebSocketLike = {
      send: vi.fn(),
      addEventListener: vi.fn((_type: string, fn: (event: { data: unknown }) => void) => {
        listener = fn;
      }),
    };
    const transport = new WebSocketServerTransport(ws);
    const handler = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(handler);

    listener!({ data: JSON.stringify({ type: "set", name: "", value: 1 }) });
    listener!({ data: JSON.stringify({ type: "cmd", name: "constructor", id: "1", args: [] }) });

    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "WebSocketServerTransport: ignoring invalid client message",
      expect.any(Error),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "WebSocketServerTransport: ignoring invalid client message",
      expect.any(Error),
    );

    warn.mockRestore();
  });

  it("receives messages via on() (ws library style) when addEventListener is absent", () => {
    let listener: ((data: unknown) => void) | null = null;
    const ws: WebSocketLike = {
      send: vi.fn(),
      on: vi.fn((_type: string, fn: (data: unknown) => void) => {
        listener = fn;
      }),
    };
    const transport = new WebSocketServerTransport(ws);
    const handler = vi.fn();

    transport.onMessage(handler);
    const msg: ClientMessage = { type: "set", name: "url", value: "/api" };
    listener!(JSON.stringify(msg));

    expect(handler).toHaveBeenCalledWith(msg);
  });

  it("ignores invalid EventEmitter payloads and warns instead of throwing", () => {
    let listener: ((data: unknown) => void) | null = null;
    const ws: WebSocketLike = {
      send: vi.fn(),
      on: vi.fn((_type: string, fn: (data: unknown) => void) => {
        listener = fn;
      }),
    };
    const transport = new WebSocketServerTransport(ws);
    const handler = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(handler);

    expect(() => listener!("not json")).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "WebSocketServerTransport: ignoring invalid client message",
      expect.any(SyntaxError),
    );

    warn.mockRestore();
  });

  it("prefers addEventListener over on() when both are present", () => {
    const ws: WebSocketLike = {
      send: vi.fn(),
      addEventListener: vi.fn(),
      on: vi.fn(),
    };
    const transport = new WebSocketServerTransport(ws);

    transport.onMessage(() => {});

    expect(ws.addEventListener).toHaveBeenCalled();
    expect(ws.on).not.toHaveBeenCalled();
  });

  it("handles non-string data via toString()", () => {
    let listener: ((event: { data: unknown }) => void) | null = null;
    const ws: WebSocketLike = {
      send: vi.fn(),
      addEventListener: vi.fn((_type: string, fn: (event: { data: unknown }) => void) => {
        listener = fn;
      }),
    };
    const transport = new WebSocketServerTransport(ws);
    const handler = vi.fn();

    transport.onMessage(handler);
    const msg: ClientMessage = { type: "sync" };
    // Simulate Buffer-like object with toString.
    const bufferLike = { toString: () => JSON.stringify(msg) };
    listener!({ data: bufferLike });

    expect(handler).toHaveBeenCalledWith(msg);
  });
});
