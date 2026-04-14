/**
 * Messages sent from client (Shell side) to server (Core side).
 */
export type ClientMessage =
  | { type: "sync" }
  | { type: "set"; name: string; value: unknown; id?: string }
  | { type: "cmd"; name: string; id: string; args: unknown[] };

export interface RemoteCapabilities {
  setAck?: boolean;
}

/**
 * Messages sent from server (Core side) to client (Shell side).
 */
export type ServerMessage =
  | {
      type: "sync";
      values: Record<string, unknown>;
      capabilities?: RemoteCapabilities;
      /**
       * Declared properties whose getter threw while building this sync
       * snapshot. The server logs the error; the client preserves any prior
       * cached value for these names.
       */
      getterFailures?: string[];
      /**
       * Declared properties whose getter returned `undefined` at snapshot
       * time. Transmitting this list lets the client disambiguate
       * "currently undefined" from "not transmitted for some other reason"
       * (e.g. ignored under a stale declaration) and dispatch an explicit
       * `undefined` event even on the initial sync.
       *
       * Optional for backward compatibility: older servers that omit the
       * field continue to work, and clients treat "omitted without a
       * getterFailure entry" as a fallback signal to reset cached values to
       * `undefined` on re-sync.
       */
      undefinedProperties?: string[];
    }
  | { type: "update"; name: string; value: unknown }
  | { type: "return"; id: string; value: unknown }
  | { type: "throw"; id: string; error: unknown };

export interface RemoteSerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface RemoteRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** @deprecated Use RemoteRequestOptions. */
export type RemoteInvokeOptions = RemoteRequestOptions;

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
  /** Release listeners and any transport-owned resources. Optional. */
  dispose?(): void;
}
