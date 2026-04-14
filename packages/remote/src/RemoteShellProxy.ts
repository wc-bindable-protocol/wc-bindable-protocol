import type { WcBindableDeclaration, UnbindFn } from "@wc-bindable/core";
import type {
  ServerTransport,
  ClientMessage,
  ServerMessage,
  RemoteCapabilities,
  RemoteSerializedError,
} from "./types.js";
import { isReservedRemoteName } from "./transport/messageValidation.js";

const REMOTE_CAPABILITIES: RemoteCapabilities = {
  setAck: true,
};

const DEFAULT_GETTER = (event: Event): unknown => (event as CustomEvent).detail;

function createRemoteShellProxyError(message: string): RemoteSerializedError {
  return {
    name: "RemoteShellProxyError",
    message,
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isSerializableAsThrowPayload(value: unknown): boolean {
  try {
    const encoded = JSON.stringify({ error: value });
    /* v8 ignore next -- JSON.stringify({ error: ... }) is string-valued in normal runtimes; this guards hostile monkey-patching */
    if (typeof encoded !== "string") return false;
    const decoded = JSON.parse(encoded) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(decoded, "error");
  } catch {
    return false;
  }
}

function getErrorCause(error: Error): unknown {
  if (!("cause" in error)) {
    return undefined;
  }

  return (error as Error & { cause?: unknown }).cause;
}

function serializeErrorCause(cause: unknown, seen: Set<Error>): unknown {
  if (cause instanceof Error) {
    return serializeErrorObject(cause, seen);
  }

  if (isSerializableAsThrowPayload(cause)) {
    return cause;
  }

  return createRemoteShellProxyError("Error cause is not JSON-serializable");
}

function serializeErrorObject(error: Error, seen: Set<Error>): RemoteSerializedError {
  if (seen.has(error)) {
    return createRemoteShellProxyError("Error cause chain contains a cycle");
  }

  seen.add(error);
  try {
    // Preserve standard Error fields plus a JSON-safe cause. Other
    // subclass-specific fields remain intentionally excluded until the
    // wire format defines a broader error metadata contract.
    const value: RemoteSerializedError = {
      name: error.name,
      message: error.message,
    };

    if (typeof error.stack === "string") {
      value.stack = error.stack;
    }

    const cause = getErrorCause(error);
    if (cause !== undefined) {
      value.cause = serializeErrorCause(cause, seen);
    }

    return value;
  } finally {
    seen.delete(error);
  }
}

function serializeThrownError(error: unknown): unknown {
  const serialized = error instanceof Error
    ? serializeErrorObject(error, new Set())
    : error;

  if (isSerializableAsThrowPayload(serialized)) {
    return serialized;
  }

  return createRemoteShellProxyError("Thrown value is not JSON-serializable");
}

/**
 * Server-side proxy that sits between the real Core and the network.
 *
 * It uses `bind()` to subscribe to the Core's events and forwards them
 * to the client via the transport. It also receives input property
 * assignments and command invocations from the client and applies them
 * to the Core.
 *
 * Usage:
 *   const core = new MyFetchCore();
 *   const shell = new RemoteShellProxy(core, transport);
 *   // Now the client's RemoteCoreProxy can interact with this Core.
 *   // If the transport exposes onClose(), cleanup is automatic.
 */
export interface RemoteShellProxyOptions {
  /**
   * Soft cap on the number of `update` messages buffered while a `sync`
   * snapshot is being built. When the buffer grows past this count, a
   * warning is logged once per proxy instance; buffering continues so
   * wire-level ordering is preserved. Defaults to `Infinity`.
   */
  maxSyncUpdateBuffer?: number;
}

function normalizeSyncBufferLimit(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(
      "RemoteShellProxy: maxSyncUpdateBuffer must be a positive integer or omitted",
    );
  }
  return value;
}

export class RemoteShellProxy {
  private _core: EventTarget;
  private _transport: ServerTransport;
  private _declaration: WcBindableDeclaration;
  private _allowedInputs: Set<string>;
  private _allowedCommands: Set<string>;
  private _unbind: UnbindFn;
  private _disposed = false;
  private _isBuildingSyncSnapshot = false;
  private _queuedSyncUpdates: Array<{ message: ServerMessage; context: string }> = [];
  private _maxSyncUpdateBuffer: number;
  private _warnedSyncBufferOverflow = false;

  constructor(
    core: EventTarget,
    transport: ServerTransport,
    options: RemoteShellProxyOptions = {},
  ) {
    this._core = core;
    this._transport = transport;
    this._maxSyncUpdateBuffer = normalizeSyncBufferLimit(options.maxSyncUpdateBuffer);

    const ctor = core.constructor as { wcBindable?: WcBindableDeclaration };
    if (!ctor.wcBindable) {
      throw new Error("RemoteShellProxy: target must have static wcBindable declaration");
    }
    this._declaration = ctor.wcBindable;
    // Reject any declared name that the wire validator reserves. Traffic for
    // such names is dropped by messageValidation.ts (sync values, set, cmd,
    // update), so letting a Shell come up with them would mean sync emits
    // that never reach clients and set/cmd frames that silently fail. Fail
    // fast at construction instead.
    for (const input of this._declaration.inputs ?? []) {
      if (isReservedRemoteName(input.name)) {
        throw new Error(
          `RemoteShellProxy: input name "${input.name}" is reserved and cannot be assigned remotely`,
        );
      }
    }
    for (const property of this._declaration.properties) {
      if (isReservedRemoteName(property.name)) {
        throw new Error(
          `RemoteShellProxy: property name "${property.name}" is reserved on the wire protocol and its sync/update messages would be dropped`,
        );
      }
    }
    for (const command of this._declaration.commands ?? []) {
      if (isReservedRemoteName(command.name)) {
        throw new Error(
          `RemoteShellProxy: command name "${command.name}" is reserved on the wire protocol and its cmd messages would be dropped`,
        );
      }
    }
    this._allowedInputs = new Set((this._declaration.inputs ?? []).map((i) => i.name));
    this._allowedCommands = new Set((this._declaration.commands ?? []).map((c) => c.name));

    // Subscribe directly to Core events.
    // Unlike bind(), this does not read current property values during
    // construction, so sync remains the single source of initial state and
    // throwing getters cannot break proxy construction.
    this._unbind = this._subscribeToCoreEvents();

    // Listen for client messages.
    transport.onMessage((msg) => this._handleMessage(msg));
    transport.onClose?.(() => this.dispose());
  }

  /** Read current values of all declared properties from the Core. */
  private _readCurrentValues(): { values: Record<string, unknown>; getterFailures: string[] } {
    const values: Record<string, unknown> = {};
    const getterFailures: string[] = [];
    const coreRecord = this._core as unknown as Record<string, unknown>;
    for (const prop of this._declaration.properties) {
      try {
        const v = coreRecord[prop.name];
        if (v !== undefined) {
          values[prop.name] = v;
        }
      } catch (err) {
        getterFailures.push(prop.name);
        console.error(
          `RemoteShellProxy: getter for "${prop.name}" threw during sync:`,
          err,
        );
      }
    }
    return { values, getterFailures };
  }

  private _subscribeToCoreEvents(): UnbindFn {
    const cleanups: Array<() => void> = [];

    for (const prop of this._declaration.properties) {
      const getter = prop.getter ?? DEFAULT_GETTER;
      const handler = (event: Event) => {
        try {
          const value = getter(event);
          const message: ServerMessage = { type: "update", name: prop.name, value };
          if (this._isBuildingSyncSnapshot) {
            this._queuedSyncUpdates.push({
              message,
              context: `update for "${prop.name}"`,
            });
            if (
              !this._warnedSyncBufferOverflow &&
              this._queuedSyncUpdates.length > this._maxSyncUpdateBuffer
            ) {
              this._warnedSyncBufferOverflow = true;
              console.warn(
                `RemoteShellProxy: sync update buffer exceeded maxSyncUpdateBuffer=${this._maxSyncUpdateBuffer}; a runaway getter side-effect may be emitting updates during sync snapshot build`,
              );
            }
            return;
          }

          this._safeSend(message, `update for "${prop.name}"`);
        } catch (err) {
          console.error(
            `RemoteShellProxy: getter for "${prop.name}" threw during update:`,
            err,
          );
        }
      };

      this._core.addEventListener(prop.event, handler);
      cleanups.push(() => this._core.removeEventListener(prop.event, handler));
    }

    return () => cleanups.forEach((cleanup) => cleanup());
  }

  private _safeSend(message: ServerMessage, context: string): boolean {
    if (this._disposed) return false;
    try {
      this._transport.send(message);
      return true;
    } catch (err) {
      console.error(`RemoteShellProxy: failed to send ${context}:`, err);
      return false;
    }
  }

  private _sendSyncResponse(): void {
    this._isBuildingSyncSnapshot = true;
    let sent = false;

    try {
      const { values, getterFailures } = this._readCurrentValues();
      sent = this._safeSend({
        type: "sync",
        values,
        capabilities: REMOTE_CAPABILITIES,
        ...(getterFailures.length > 0 ? { getterFailures } : {}),
      }, "sync response");
    } finally {
      this._isBuildingSyncSnapshot = false;
    }

    const queuedUpdates = this._queuedSyncUpdates;
    this._queuedSyncUpdates = [];
    this._warnedSyncBufferOverflow = false;
    if (!sent) {
      return;
    }

    for (const queued of queuedUpdates) {
      this._safeSend(queued.message, queued.context);
    }
  }

  private _handleMessage(msg: ClientMessage): void {
    // The ServerTransport interface has no way to unregister an onMessage
    // handler, so dispose() sets this flag and we drop every subsequent
    // inbound message. This prevents late-arriving or reused-transport
    // messages from mutating the Core or invoking commands after teardown.
    if (this._disposed) return;
    switch (msg.type) {
      case "sync": {
        this._sendSyncResponse();
        break;
      }
      case "set": {
        if (!this._allowedInputs.has(msg.name)) {
          if (msg.id != null) {
            this._safeSend({
              type: "throw",
              id: msg.id,
              error: createRemoteShellProxyError(
                `Input "${msg.name}" is not declared in wcBindable.inputs`,
              ),
            }, `throw response for input "${msg.name}"`);
            return;
          }

          console.warn(
            `RemoteShellProxy: ignored set for undeclared input "${msg.name}"`,
          );
          return;
        }
        // Reserved names are rejected while building _allowedInputs, so this
        // should be unreachable for normal declarations. Keep the guard at the
        // assignment boundary as defense in depth in case a malformed message,
        // mutated declaration, or JS-level private-field escape bypasses the
        // constructor-time validation.
        if (isReservedRemoteName(msg.name)) {
          if (msg.id != null) {
            this._safeSend({
              type: "throw",
              id: msg.id,
              error: createRemoteShellProxyError(
                `Input "${msg.name}" is reserved and cannot be assigned remotely`,
              ),
            }, `throw response for input "${msg.name}"`);
            return;
          }

          console.warn(
            `RemoteShellProxy: ignored set for reserved input "${msg.name}"`,
          );
          return;
        }
        try {
          (this._core as unknown as Record<string, unknown>)[msg.name] = msg.value;
          if (msg.id != null) {
            this._safeSend({ type: "return", id: msg.id, value: undefined }, `return response for input "${msg.name}"`);
          }
        } catch (err) {
          if (msg.id != null) {
            this._safeSend({
              type: "throw",
              id: msg.id,
              error: serializeThrownError(err),
            }, `throw response for input "${msg.name}"`);
            return;
          }

          console.error(
            `RemoteShellProxy: setter for "${msg.name}" threw:`,
            err,
          );
        }
        break;
      }
      case "cmd": {
        if (!this._allowedCommands.has(msg.name)) {
          this._safeSend({
            type: "throw",
            id: msg.id,
            error: createRemoteShellProxyError(
              `Command "${msg.name}" is not declared in wcBindable.commands`,
            ),
          }, `throw response for command "${msg.name}"`);
          return;
        }
        const method = (this._core as unknown as Record<string, (...args: unknown[]) => unknown>)[msg.name];
        if (typeof method !== "function") {
          this._safeSend({
            type: "throw",
            id: msg.id,
            error: createRemoteShellProxyError(`Method "${msg.name}" not found on Core`),
          }, `throw response for command "${msg.name}"`);
          return;
        }
        try {
          const result = method.call(this._core, ...msg.args);
          // Use thenable detection instead of `instanceof Promise` so
          // cross-realm Promises and user-land thenables are awaited
          // correctly. Promise.resolve adopts the thenable's state and
          // yields a well-behaved native Promise for the continuation.
          if (isThenable(result)) {
            Promise.resolve(result)
              .then((value) => {
                if (this._disposed) return;
                this._safeSend({ type: "return", id: msg.id, value }, `return response for command "${msg.name}"`);
              })
              .catch((err) => {
                if (this._disposed) return;
                this._safeSend({
                  type: "throw",
                  id: msg.id,
                  error: serializeThrownError(err),
                }, `throw response for command "${msg.name}"`);
              });
          } else {
            this._safeSend({ type: "return", id: msg.id, value: result }, `return response for command "${msg.name}"`);
          }
        } catch (err) {
          this._safeSend({
            type: "throw",
            id: msg.id,
            error: serializeThrownError(err),
          }, `throw response for command "${msg.name}"`);
        }
        break;
      }
    }
  }

  /**
   * Stop forwarding events from the Core and reject any further inbound
   * client messages. Call when the connection closes. Idempotent.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._unbind();
    this._transport.dispose?.();
  }
}
