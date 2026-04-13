import type { ClientTransport, ClientMessage, ServerMessage } from "../types.js";
import { isServerMessage } from "./messageValidation.js";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function parseServerMessage(data: unknown): ServerMessage | null {
  try {
    const message = JSON.parse(typeof data === "string" ? data : String(data));
    if (!isServerMessage(message)) {
      throw new Error("invalid server message shape");
    }
    return message;
  } catch (error) {
    console.warn("WebSocketClientTransport: ignoring invalid server message", error);
    return null;
  }
}

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
  private _disposed = false;
  private _openListener: (() => void) | null = null;
  private _failListener: (() => void) | null = null;
  private _messageListener: ((event: MessageEvent) => void) | null = null;
  private _closeListener: (() => void) | null = null;

  constructor(ws: WebSocket) {
    this._ws = ws;

    if (ws.readyState === WS_CLOSING || ws.readyState === WS_CLOSED) {
      // Already dead on arrival — no listeners needed.
      this._buffer = null;
      this._closed = true;
      return;
    }

    if (ws.readyState === WS_OPEN) {
      this._buffer = null;
    } else {
      this._buffer = [];
      this._openListener = () => {
        // Guard against a close/error racing the open flush.
        if (this._closed || this._buffer === null) return;
        const queued = this._buffer;
        this._buffer = null;
        for (const msg of queued) {
          ws.send(JSON.stringify(msg));
        }
      };
      ws.addEventListener("open", this._openListener, { once: true });
    }

    // Always watch for close/error regardless of initial readyState so
    // that a socket that transitions to CLOSED *after* construction is
    // reflected in our internal state. Without this, send() called after
    // a post-construction close would pass the _closed guard and invoke
    // ws.send on a closed socket, producing runtime-dependent behavior.
    this._failListener = () => {
      this._buffer = null;
      this._closed = true;
    };
    ws.addEventListener("close", this._failListener, { once: true });
    ws.addEventListener("error", this._failListener, { once: true });
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
    if (this._messageListener) {
      this._ws.removeEventListener("message", this._messageListener);
    }

    const listener = (event: MessageEvent) => {
      const msg = parseServerMessage(event.data);
      if (!msg) return;
      handler(msg);
    };
    this._messageListener = listener;
    this._ws.addEventListener("message", listener);
  }

  onClose(handler: () => void): void {
    if (this._closeListener) {
      this._ws.removeEventListener("close", this._closeListener);
      this._ws.removeEventListener("error", this._closeListener);
    }

    const once = { once: true } as const;
    // Fire on whichever comes first — close or error.
    // Guard against double invocation when both fire.
    let called = false;
    const guard = () => {
      if (called) return;
      called = true;
      handler();
      if (this._closeListener === guard) {
        this._closeListener = null;
      }
    };
    this._closeListener = guard;
    this._ws.addEventListener("close", guard, once);
    this._ws.addEventListener("error", guard, once);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._buffer = null;
    this._closed = true;

    if (this._openListener) {
      this._ws.removeEventListener("open", this._openListener);
      this._openListener = null;
    }

    if (this._failListener) {
      this._ws.removeEventListener("close", this._failListener);
      this._ws.removeEventListener("error", this._failListener);
      this._failListener = null;
    }

    if (this._messageListener) {
      this._ws.removeEventListener("message", this._messageListener);
      this._messageListener = null;
    }

    if (this._closeListener) {
      this._ws.removeEventListener("close", this._closeListener);
      this._ws.removeEventListener("error", this._closeListener);
      this._closeListener = null;
    }
  }
}
