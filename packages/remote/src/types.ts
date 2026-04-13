/**
 * Messages sent from client (Shell side) to server (Core side).
 */
export type ClientMessage =
  | { type: "sync" }
  | { type: "set"; name: string; value: unknown; id?: string }
  | { type: "cmd"; name: string; id: string; args: unknown[] };

/**
 * Messages sent from server (Core side) to client (Shell side).
 */
export type ServerMessage =
  | { type: "sync"; values: Record<string, unknown> }
  | { type: "update"; name: string; value: unknown }
  | { type: "return"; id: string; value: unknown }
  | { type: "throw"; id: string; error: unknown };

export interface RemoteSerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface RemoteInvokeOptions {
  signal?: AbortSignal;
}

/**
 * Transport interface for the client (Shell) side.
 *
 * Implementations wrap a concrete transport (WebSocket, MessagePort, etc.)
 * and handle serialization.
 */
export interface ClientTransport {
  /** Send a message to the server. */
  send(message: ClientMessage): void;
  /**
   * Register the transport's single server-message handler.
   *
   * Consumers are expected to call this at most once per transport
   * lifetime. Implementations may replace any previously registered
   * handler when called again.
   */
  onMessage(handler: (message: ServerMessage) => void): void;
  /**
   * Register the transport's single close/error handler. Optional.
   *
   * Consumers are expected to call this at most once per transport
   * lifetime. Implementations may replace any previously registered
   * handler when called again.
   */
  onClose?(handler: () => void): void;
  /** Release listeners and any transport-owned resources. Optional. */
  dispose?(): void;
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
  /**
   * Register the transport's single client-message handler.
   *
   * Consumers are expected to call this at most once per transport
   * lifetime. Implementations may replace any previously registered
   * handler when called again.
   */
  onMessage(handler: (message: ClientMessage) => void): void;
  /**
   * Register the transport's single close/error handler. Optional.
   *
   * Consumers are expected to call this at most once per transport
   * lifetime. Implementations may replace any previously registered
   * handler when called again.
   */
  onClose?(handler: () => void): void;
}
