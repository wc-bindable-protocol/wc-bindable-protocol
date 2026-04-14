import type { ClientTransport, ClientMessage, ServerMessage } from "../types.js";
import { isServerMessage } from "./messageValidation.js";
import { type Logger, resolveLogger } from "../logger.js";

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

function normalizeLimit(value: number | undefined, label: string): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(
      `WebSocketClientTransport: ${label} must be a positive integer or omitted; use Infinity for no limit`,
    );
  }
  return value;
}

function isBinaryMessagePayload(data: unknown): boolean {
  /* v8 ignore next -- ArrayBuffer is available in supported runtimes; this keeps the fallback defensive */
  if (typeof ArrayBuffer !== "undefined") {
    if (data instanceof ArrayBuffer) {
      return true;
    }

    if (ArrayBuffer.isView(data)) {
      return true;
    }
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return true;
  }

  return typeof Buffer !== "undefined" && Buffer.isBuffer(data);
}

function parseServerMessage(data: unknown, logger: Logger): ServerMessage | null {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    logger.warn(
      "WebSocketClientTransport: ignoring invalid server message",
      new Error("Blob payloads are not supported; expected a text JSON frame"),
    );
    return null;
  }

  try {
    const message = JSON.parse(typeof data === "string" ? data : String(data));
    if (!isServerMessage(message)) {
      throw new Error("invalid server message shape");
    }
    return message;
  } catch (error) {
    logger.warn("WebSocketClientTransport: ignoring invalid server message", error);
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
export interface WebSocketClientTransportOptions {
  /**
   * Soft cap on the pre-open send() buffer. When a send() would push the
   * buffer past this count before the socket has opened, it throws
   * synchronously instead of letting the buffer grow unboundedly.
   * Defaults to `Infinity` (no limit) to preserve prior behavior.
   */
  maxPreOpenQueue?: number;
  /**
   * Logger used for diagnostic output (invalid server frames, unexpected
   * binary payloads). Defaults to `console.warn`. Inject a structured
   * logger in production.
   */
  logger?: Logger;
}

export class WebSocketClientTransport implements ClientTransport {
  private _ws: WebSocket;
  // Buffer the already-serialized payload, not the raw message, so that a
  // non-JSON-serializable value (BigInt, cyclic object, …) throws
  // synchronously from send() and reaches the caller's try/catch. Buffering
  // the raw message would defer JSON.stringify to the open handler, where
  // the exception would escape as an unhandled event-listener error and the
  // original send() call would already have returned successfully.
  private _buffer: string[] | null;
  private _closed = false;
  private _disposed = false;
  private _warnedBinaryPayload = false;
  private _maxPreOpenQueue: number;
  private _logger: Logger;
  private _openListener: (() => void) | null = null;
  private _failListener: (() => void) | null = null;
  private _messageListener: ((event: MessageEvent) => void) | null = null;
  private _closeListener: (() => void) | null = null;
  private _errorListener: (() => void) | null = null;

  constructor(ws: WebSocket, options: WebSocketClientTransportOptions = {}) {
    this._ws = ws;
    this._maxPreOpenQueue = normalizeLimit(options.maxPreOpenQueue, "maxPreOpenQueue");
    this._logger = resolveLogger(options.logger);

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
        /* v8 ignore next -- _openListener only runs while a buffer exists and before the transport is marked closed */
        if (this._closed || this._buffer === null) return;
        const queued = this._buffer;
        this._buffer = null;
        for (const payload of queued) {
          if (this._closed) break;
          ws.send(payload);
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
    if (this._buffer !== null && this._buffer.length >= this._maxPreOpenQueue) {
      throw new Error(
        `WebSocketClientTransport: pre-open queue exceeded maxPreOpenQueue=${this._maxPreOpenQueue}`,
      );
    }
    const payload = JSON.stringify(message);
    if (this._buffer !== null) {
      this._buffer.push(payload);
    } else {
      this._ws.send(payload);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): void {
    if (this._messageListener) {
      this._ws.removeEventListener("message", this._messageListener);
    }

    const listener = (event: MessageEvent) => {
      if (!this._warnedBinaryPayload && isBinaryMessagePayload(event.data)) {
        this._warnedBinaryPayload = true;
        this._logger.warn(
          "WebSocketClientTransport: received a binary message payload; this transport expects text JSON frames from the server. Check the server framing or browser binaryType.",
        );
      }
      const msg = parseServerMessage(event.data, this._logger);
      /* v8 ignore next -- invalid frames are dropped after parseServerMessage logs a warning */
      if (!msg) return;
      handler(msg);
    };
    this._messageListener = listener;
    this._ws.addEventListener("message", listener);
  }

  onClose(handler: () => void): void {
    if (this._closeListener && this._errorListener) {
      this._ws.removeEventListener("close", this._closeListener);
      this._ws.removeEventListener("error", this._errorListener);
    }

    // Fire on whichever comes first — close or error.
    // Guard against double invocation when both fire.
    let called = false;
    let closeListener: (() => void) | null = null;
    let errorListener: (() => void) | null = null;
    const cleanup = () => {
      /* v8 ignore start -- these guards only protect against manual mutation of the listener locals */
      if (closeListener) {
        this._ws.removeEventListener("close", closeListener);
      }
      if (errorListener) {
        this._ws.removeEventListener("error", errorListener);
      }
      if (this._closeListener === closeListener) {
        this._closeListener = null;
      }
      if (this._errorListener === errorListener) {
        this._errorListener = null;
      }
      /* v8 ignore stop */
    };
    const guard = () => {
      if (called) return;
      called = true;
      cleanup();
      handler();
    };
    closeListener = guard;
    errorListener = guard;
    this._closeListener = closeListener;
    this._errorListener = errorListener;
    this._ws.addEventListener("close", closeListener);
    this._ws.addEventListener("error", errorListener);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._buffer = null;
    this._closed = true;

    /* v8 ignore start -- each listener is optional depending on connection state and which APIs were registered */
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

    if (this._closeListener && this._errorListener) {
      this._ws.removeEventListener("close", this._closeListener);
      this._ws.removeEventListener("error", this._errorListener);
      this._closeListener = null;
      this._errorListener = null;
    }
    /* v8 ignore stop */
  }
}
