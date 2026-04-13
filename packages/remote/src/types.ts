/**
 * Messages sent from client (Shell side) to server (Core side).
 */
export type ClientMessage =
  | { type: "sync" }
  | { type: "set"; name: string; value: unknown }
  | { type: "cmd"; name: string; id: string; args: unknown[] };

/**
 * Messages sent from server (Core side) to client (Shell side).
 */
export type ServerMessage =
  | { type: "sync"; values: Record<string, unknown> }
  | { type: "update"; name: string; value: unknown }
  | { type: "return"; id: string; value: unknown }
  | { type: "throw"; id: string; error: unknown };

/**
 * Transport interface for the client (Shell) side.
 *
 * Implementations wrap a concrete transport (WebSocket, MessagePort, etc.)
 * and handle serialization.
 */
export interface ClientTransport {
  /** Send a message to the server. */
  send(message: ClientMessage): void;
  /** Register a handler for messages received from the server. */
  onMessage(handler: (message: ServerMessage) => void): void;
  /** Register a handler called when the transport is closed or fails. Optional. */
  onClose?(handler: () => void): void;
}

/**
 * Transport interface for the server (Core) side.
 *
 * Implementations wrap a concrete transport (WebSocket, MessagePort, etc.)
 * and handle serialization.
 */
export interface ServerTransport {
  /** Send a message to the client. */
  send(message: ServerMessage): void;
  /** Register a handler for messages received from the client. */
  onMessage(handler: (message: ClientMessage) => void): void;
}
