import type { ServerTransport, ServerMessage, ClientMessage } from "../types.js";

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
  on?(type: "message", listener: (data: unknown) => void): void;
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

  constructor(ws: WebSocketLike) {
    this._ws = ws;
  }

  send(message: ServerMessage): void {
    this._ws.send(JSON.stringify(message));
  }

  onMessage(handler: (message: ClientMessage) => void): void {
    if (this._ws.addEventListener) {
      // Standard API: event.data contains the payload.
      this._ws.addEventListener("message", (event: { data: unknown }) => {
        const raw = event.data;
        const msg = JSON.parse(typeof raw === "string" ? raw : String(raw)) as ClientMessage;
        handler(msg);
      });
    } else if (this._ws.on) {
      // Node EventEmitter style (ws library): data is passed directly.
      this._ws.on("message", (data: unknown) => {
        const msg = JSON.parse(typeof data === "string" ? data : String(data)) as ClientMessage;
        handler(msg);
      });
    }
  }
}
