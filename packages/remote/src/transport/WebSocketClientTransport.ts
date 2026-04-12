import type { ClientTransport, ClientMessage, ServerMessage } from "../types.js";

/**
 * ClientTransport implementation using the standard WebSocket API.
 *
 * Messages sent before the connection is open are buffered and flushed
 * automatically once the WebSocket reaches the OPEN state. If the
 * connection fails (close/error before open), buffered messages are
 * discarded and subsequent `send()` calls throw.
 *
 * Works in browsers and any runtime that provides the global `WebSocket`
 * (Deno, Bun, Node.js 22+, etc.). No external dependencies.
 *
 * Usage:
 *   const ws = new WebSocket("ws://localhost:3000");
 *   const transport = new WebSocketClientTransport(ws);
 *   const proxy = createRemoteCoreProxy(declaration, transport);
 */
export class WebSocketClientTransport implements ClientTransport {
  private _ws: WebSocket;
  private _buffer: ClientMessage[] | null;
  private _closed = false;

  constructor(ws: WebSocket) {
    this._ws = ws;

    if (ws.readyState === WebSocket.OPEN) {
      this._buffer = null;
    } else if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      this._buffer = null;
      this._closed = true;
    } else {
      this._buffer = [];

      ws.addEventListener("open", () => {
        const queued = this._buffer!;
        this._buffer = null;
        for (const msg of queued) {
          ws.send(JSON.stringify(msg));
        }
      }, { once: true });

      const onFail = () => {
        this._buffer = null;
        this._closed = true;
      };
      ws.addEventListener("close", onFail, { once: true });
      ws.addEventListener("error", onFail, { once: true });
    }
  }

  send(message: ClientMessage): void {
    if (this._closed) {
      throw new Error("WebSocketClientTransport: connection is closed");
    }
    if (this._buffer !== null) {
      this._buffer.push(message);
    } else {
      this._ws.send(JSON.stringify(message));
    }
  }

  onMessage(handler: (message: ServerMessage) => void): void {
    this._ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as ServerMessage;
      handler(msg);
    });
  }

  onClose(handler: () => void): void {
    const once = { once: true } as const;
    // Fire on whichever comes first — close or error.
    // Guard against double invocation when both fire.
    let called = false;
    const guard = () => {
      if (called) return;
      called = true;
      handler();
    };
    this._ws.addEventListener("close", guard, once);
    this._ws.addEventListener("error", guard, once);
  }
}
