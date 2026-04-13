import type { ServerTransport, ServerMessage, ClientMessage } from "../types.js";
import { isClientMessage } from "./messageValidation.js";

function parseClientMessage(data: unknown): ClientMessage | null {
  try {
    const message = typeof data === "string"
      ? JSON.parse(data)
      : typeof Buffer !== "undefined" && Buffer.isBuffer(data)
        ? JSON.parse(data.toString("utf8"))
        : JSON.parse(String(data));

    if (!isClientMessage(message)) {
      throw new Error("invalid client message shape");
    }

    return message;
  } catch (error) {
    console.warn("WebSocketServerTransport: ignoring invalid client message", error);
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
  private _closeListenerAttached = false;
  private _closeListener: (() => void) | null = null;

  constructor(ws: WebSocketLike) {
    this._ws = ws;
  }

  send(message: ServerMessage): void {
    this._ws.send(JSON.stringify(message));
  }

  onMessage(handler: (message: ClientMessage) => void): void {
    this._messageHandler = handler;
    if (this._messageListenerAttached) return;

    const dispatch = (data: unknown) => {
      if (!this._messageHandler) return;
      const msg = parseClientMessage(data);
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
      return;
    }
    if (this._closeListenerAttached) return;

    const guard = () => {
      if (this._closeFired) return;
      this._closeFired = true;
      this._closeHandler?.();
    };
    this._closeListener = guard;

    if (this._ws.addEventListener) {
      this._ws.addEventListener("close", this._closeListener);
      this._ws.addEventListener("error", this._closeListener);
      this._closeListenerAttached = true;
    } else if (this._ws.on) {
      this._ws.on("close", this._closeListener);
      this._ws.on("error", this._closeListener);
      this._closeListenerAttached = true;
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
    this._closeListenerAttached = false;
    this._closeListener = null;
  }
}
