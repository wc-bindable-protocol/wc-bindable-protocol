import type { ServerTransport, ServerMessage, ClientMessage } from "../types.js";
import { isClientMessage } from "./messageValidation.js";
import { type Logger, resolveLogger } from "../logger.js";

function decodeUtf8Bytes(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(bytes);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("utf8");
  }

  return String(bytes);
}

function toJsonText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (typeof ArrayBuffer !== "undefined") {
    if (data instanceof ArrayBuffer) {
      return decodeUtf8Bytes(new Uint8Array(data));
    }

    if (ArrayBuffer.isView(data)) {
      return decodeUtf8Bytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  }

  return String(data);
}

/**
 * MUST-level default per SPEC-extensions.md § Wire framing and encoding rule 3
 * — every conformant proxy / shell MUST enforce a maximum decoded envelope
 * byte length at the transport-frame layer before JSON parsing. 1 MiB is the
 * spec-pinned baseline; raise it explicitly for legitimate large-payload
 * deployments or lower it for tighter untrusted-peer hardening via the
 * `maxFrameBytes` constructor option.
 */
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

function normalizeFrameBytesLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(
      "WebSocketServerTransport: maxFrameBytes must be a positive integer or omitted",
    );
  }
  return value;
}

function frameByteLength(data: unknown): number {
  if (typeof data === "string") {
    // UTF-8 byte length. Buffer.byteLength is preferred when available;
    // fall back to a TextEncoder-based count for non-Node runtimes.
    if (typeof Buffer !== "undefined") {
      return Buffer.byteLength(data, "utf8");
    }
    /* v8 ignore next -- TextEncoder is available in all spec-supported runtimes; fallback for defensive sizing only */
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(data).byteLength;
    }
    /* v8 ignore next 2 */
    return data.length; // pessimistic but bounded
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (typeof ArrayBuffer !== "undefined") {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
  }
  /* v8 ignore next -- non-string/non-binary payloads fall through to the parse step which rejects them with a separate diagnostic */
  return 0;
}

function parseClientMessage(
  data: unknown,
  logger: Logger,
  maxFrameBytes: number,
): ClientMessage | null {
  // Enforce maxFrameBytes BEFORE invoking JSON.parse so the parser itself is
  // bounded (per SPEC-extensions.md § Wire framing and encoding rule 3 MUST).
  // Oversized inbound frames are dropped with a warn-log; the transport
  // stays open so a single oversized frame does NOT escalate to channel
  // teardown (the proxy / shell decides escalation via the same path it
  // uses for any other malformed-inbound envelope).
  if (Number.isFinite(maxFrameBytes)) {
    const byteLength = frameByteLength(data);
    if (byteLength > maxFrameBytes) {
      logger.warn(
        `WebSocketServerTransport: dropping inbound frame of ${byteLength} bytes; ` +
          `exceeds maxFrameBytes=${maxFrameBytes} (configurable via constructor options). ` +
          "Per SPEC-extensions.md § Wire framing and encoding (rule 3 MUST), oversized " +
          "frames are dropped at the transport-frame layer before JSON parsing.",
      );
      return null;
    }
  }
  try {
    const message = JSON.parse(toJsonText(data));

    if (!isClientMessage(message)) {
      throw new Error("invalid client message shape");
    }

    return message;
  } catch (error) {
    logger.warn("WebSocketServerTransport: ignoring invalid client message", error);
    return null;
  }
}

/**
 * Minimal interface for a server-side WebSocket connection.
 *
 * Supports two listener patterns:
 * - Standard API: `addEventListener("message", (event) => { event.data })`
 *   (Deno, Bun, Node.js 22+, browsers)
 * - Node EventEmitter: `on("message", (data) => {})`
 *   (ws library, legacy Node.js WebSocket implementations)
 *
 * Incoming payloads are expected to already be text JSON or UTF-8 bytes
 * (`Buffer`, `Uint8Array`, `ArrayBuffer`, etc.). Blob-like payloads are not
 * decoded here because the ServerTransport contract is synchronous.
 *
 * If both are present, `addEventListener` is preferred.
 */
export interface WebSocketLike {
  send(data: string): void;
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener?(type: "close", listener: () => void): void;
  addEventListener?(type: "error", listener: () => void): void;
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: "close", listener: () => void): void;
  removeEventListener?(type: "error", listener: () => void): void;
  on?(type: "message", listener: (data: unknown) => void): void;
  on?(type: "close", listener: () => void): void;
  on?(type: "error", listener: () => void): void;
  off?(type: "message", listener: (data: unknown) => void): void;
  off?(type: "close", listener: () => void): void;
  off?(type: "error", listener: () => void): void;
}

/**
 * ServerTransport implementation using a WebSocket-like object.
 *
 * Accepts any object that implements `send(string)` and either
 * `addEventListener("message", ...)` or `on("message", ...)`.
 *
 * Usage:
 *   // Standard WebSocket API (Deno, Bun, Node.js 22+)
 *   const transport = new WebSocketServerTransport(socket);
 *
 *   // ws library (Node.js)
 *   import { WebSocketServer } from "ws";
 *   wss.on("connection", (ws) => {
 *     const transport = new WebSocketServerTransport(ws);
 *     const shell = new RemoteShellProxy(core, transport);
 *   });
 */
export interface WebSocketServerTransportOptions {
  /**
   * Maximum decoded inbound frame byte length. Frames whose size exceeds
   * the limit are dropped at the transport layer **before** invoking
   * `JSON.parse`, with a warn-log naming the offending size; the transport
   * stays open. Per [SPEC-extensions.md § Wire framing and encoding rule 3
   * MUST]; spec-pinned default is **1 MiB (1 048 576 bytes)**. Raise
   * explicitly for legitimate large-payload applications; lower for
   * tighter untrusted-peer hardening. MUST be a positive integer if
   * provided.
   */
  maxFrameBytes?: number;
  /**
   * Logger used for diagnostic output (invalid client frames, oversized
   * inbound frames). Defaults to `console.warn`. Inject a structured
   * logger in production.
   */
  logger?: Logger;
}

export class WebSocketServerTransport implements ServerTransport {
  private _ws: WebSocketLike;
  // WebSocketLike does not require a removeEventListener/off method, so we
  // cannot swap listeners on the underlying socket. Instead, we attach each
  // underlying listener at most once and route through a mutable handler
  // field. Re-registering replaces the field — honoring the "later
  // registration may replace earlier" contract in ServerTransport.
  private _messageHandler: ((message: ClientMessage) => void) | null = null;
  private _messageListenerAttached = false;
  private _messageEventListener: ((event: { data: unknown }) => void) | null = null;
  private _messageDataListener: ((data: unknown) => void) | null = null;
  private _closeHandler: (() => void) | null = null;
  private _closeFired = false;
  private _closeListener: (() => void) | null = null;
  private _logger: Logger;
  private _maxFrameBytes: number;

  constructor(ws: WebSocketLike, options: WebSocketServerTransportOptions = {}) {
    this._ws = ws;
    this._logger = resolveLogger(options.logger);
    this._maxFrameBytes = normalizeFrameBytesLimit(options.maxFrameBytes);

    const guard = () => {
      if (this._closeFired) return;
      this._closeFired = true;
      this._closeHandler?.();
    };
    this._closeListener = guard;

    if (this._ws.addEventListener) {
      this._ws.addEventListener("close", this._closeListener);
      this._ws.addEventListener("error", this._closeListener);
    } else if (this._ws.on) {
      this._ws.on("close", this._closeListener);
      this._ws.on("error", this._closeListener);
    }
  }

  send(message: ServerMessage): void {
    this._ws.send(JSON.stringify(message));
  }

  onMessage(handler: (message: ClientMessage) => void): void {
    this._messageHandler = handler;
    if (this._messageListenerAttached) return;

    const dispatch = (data: unknown) => {
      if (!this._messageHandler) return;
      const msg = parseClientMessage(data, this._logger, this._maxFrameBytes);
      if (!msg) return;
      this._messageHandler(msg);
    };

    if (this._ws.addEventListener) {
      // Standard API: event.data contains the payload.
      this._messageEventListener = (event: { data: unknown }) => {
        dispatch(event.data);
      };
      this._ws.addEventListener("message", this._messageEventListener);
      this._messageListenerAttached = true;
    } else if (this._ws.on) {
      // Node EventEmitter style (ws library): data is passed directly.
      this._messageDataListener = dispatch;
      this._ws.on("message", this._messageDataListener);
      this._messageListenerAttached = true;
    }
  }

  onClose(handler: () => void): void {
    this._closeHandler = handler;
    if (this._closeFired) {
      handler();
    }
  }

  dispose(): void {
    if (this._messageEventListener && this._ws.removeEventListener) {
      this._ws.removeEventListener("message", this._messageEventListener);
    }
    if (this._messageDataListener && this._ws.off) {
      this._ws.off("message", this._messageDataListener);
    }
    if (this._closeListener && this._ws.removeEventListener) {
      this._ws.removeEventListener("close", this._closeListener);
      this._ws.removeEventListener("error", this._closeListener);
    }
    if (this._closeListener && this._ws.off) {
      this._ws.off("close", this._closeListener);
      this._ws.off("error", this._closeListener);
    }

    this._messageHandler = null;
    this._messageListenerAttached = false;
    this._messageEventListener = null;
    this._messageDataListener = null;
    this._closeHandler = null;
    this._closeListener = null;
  }
}
