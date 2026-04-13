import { describe, it, expect, vi } from "vitest";
import { WebSocketClientTransport } from "../src/index.js";
import { MockBrowserWebSocket } from "./_helpers.js";

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

  it("stops flushing buffered messages if the socket closes during the open flush", () => {
    class ClosingOnFirstSendWebSocket extends MockBrowserWebSocket {
      private _sendCount = 0;

      override send(data: string): void {
        this._sendCount += 1;
        super.send(data);
        if (this._sendCount === 1) {
          this.emit("close");
        }
      }
    }

    const ws = new ClosingOnFirstSendWebSocket(WebSocket.CONNECTING);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);

    transport.send({ type: "sync" });
    transport.send({ type: "set", name: "url", value: "/api" });

    ws.emit("open");

    expect(ws.sent).toEqual([
      JSON.stringify({ type: "sync" }),
    ]);
    expect(() => transport.send({ type: "sync" })).toThrow("connection is closed");
  });

  it("throws synchronously from send() when the message is not JSON-serializable, even while buffering", () => {
    // A non-JSON value (BigInt) must surface as a synchronous send() failure
    // while the socket is still CONNECTING. Deferring JSON.stringify to the
    // open flush would let the exception escape into an event listener and
    // the caller's try/catch (and RemoteCoreProxy's pending reject) would be
    // skipped.
    const ws = new MockBrowserWebSocket(WebSocket.CONNECTING);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);

    expect(() =>
      transport.send({ type: "set", name: "value", value: 1n }),
    ).toThrow(TypeError);

    // The failed message must not be retained in the buffer — otherwise the
    // same exception would re-throw during the open flush.
    ws.emit("open");
    expect(ws.sent).toEqual([]);
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

  it("accepts update messages without a value field as an undefined update", () => {
    // JSON.stringify drops `value: undefined`, so the server emits an
    // update with no `value` key when reverting a property to undefined.
    // The client must treat that as an undefined update rather than
    // discarding the message.
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const onMessage = vi.fn();

    transport.onMessage(onMessage);
    ws.emit("message", { data: JSON.stringify({ type: "update", name: "value" }) });

    expect(onMessage).toHaveBeenCalledWith({ type: "update", name: "value" });
  });

  it("deduplicates the specialized binary warning but still warns for each dropped binary payload", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const onMessage = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const binaryWarning = "WebSocketClientTransport: received a binary message payload; this transport expects text JSON frames from the server. Check the server framing or browser binaryType.";
    const invalidMessageWarning = "WebSocketClientTransport: ignoring invalid server message";

    transport.onMessage(onMessage);
    ws.emit("message", { data: new Uint8Array([123, 125]) });
    ws.emit("message", { data: new Uint8Array([123, 125]) });

    expect(onMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(binaryWarning);
    expect(warnSpy.mock.calls.filter(([message]) => message === binaryWarning)).toHaveLength(1);
    expect(warnSpy.mock.calls.filter(([message]) => message === invalidMessageWarning)).toHaveLength(2);

    warnSpy.mockRestore();
  });

  it("rejects Blob payloads with a clearer diagnostic before parse fallback", () => {
    const ws = new MockBrowserWebSocket(WebSocket.OPEN);
    const transport = new WebSocketClientTransport(ws as unknown as WebSocket);
    const onMessage = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    transport.onMessage(onMessage);
    ws.emit("message", { data: new Blob([JSON.stringify({ type: "sync", values: { value: 1 } })]) });

    expect(onMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "WebSocketClientTransport: ignoring invalid server message",
      expect.objectContaining({ message: "Blob payloads are not supported; expected a text JSON frame" }),
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
