import type { WcBindableDeclaration, UnbindFn } from "@wc-bindable/core";
import type {
  ServerTransport,
  ClientMessage,
  ServerMessage,
  RemoteCapabilities,
  RemoteSerializedError,
} from "./types.js";
import { isReservedRemoteName } from "./transport/messageValidation.js";
import { type Logger, resolveLogger } from "./logger.js";
import { buildDeclarationFingerprint } from "./declarationFingerprint.js";
import { describeNonJsonArguments, describeNonJsonValue, normalizeMaxDepth, toJsonValue } from "./jsonValue.js";

const REMOTE_CAPABILITIES: RemoteCapabilities = {
  setAck: true,
  // Advertised so consumers can distinguish a modern producer that has
  // no undefined / failed-getter properties at the moment ("field
  // present, list empty") from a legacy producer that does not know
  // about these fields at all ("field absent"). See SPEC-extensions.md
  // § sync response capabilities.
  undefinedProperties: true,
  getterFailures: true,
};

const DEFAULT_GETTER = (event: Event): unknown => (event as CustomEvent).detail;

const REMOTE_THROW = "WC_BINDABLE_REMOTE_THROW";
const RESERVED_CODE_PREFIX = /^wc_bindable_/i;

function createRemoteShellProxyError(message: string, code: string): RemoteSerializedError {
  // Emission site A: errors the shell synthesizes from a known protocol
  // condition MUST carry `code` (SPEC-extensions.md § Error envelope).
  return {
    name: "RemoteShellProxyError",
    message,
    code,
  };
}

/** SPEC-extensions.md § Message types — client → server: `id` MUST be a non-empty string. */
function hasWellFormedId(msg: { id?: unknown }): boolean {
  return typeof msg.id === "string" && msg.id.length > 0;
}

/** The message's id if well-formed, else `null` (see {@link hasWellFormedId}). */
function wellFormedId(msg: { id?: unknown }): string | null {
  return hasWellFormedId(msg) ? (msg.id as string) : null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** `instanceof` runs a Proxy trap on the thrown value; a throwing trap means "not an Error". */
function isErrorInstance(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
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

/**
 * SPEC-extensions.md § Canonical mapping for non-Error throws → safe-
 * stringification rule: the property read happens inside the try, so a
 * hostile getter cannot escape.
 */
function safeStringFrom(read: () => unknown, fallback: string): string {
  try {
    const s = String(read());
    return s || fallback;
  } catch {
    return fallback;
  }
}

function readStringCode(error: object): string | undefined {
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `cause` on the wire is a `JsonValue` or absent: a nested Error is
 * serialized like the thrown one, any other value is validated and copied,
 * and a non-JsonValue (or a cycle back to an Error already being serialized)
 * is omitted (SPEC-extensions.md § Error envelope, "`cause` field on the wire").
 */
function serializeErrorCause(cause: unknown, seen: Set<Error>, maxDepth: number): unknown {
  if (isErrorInstance(cause)) {
    return seen.has(cause) ? undefined : serializeErrorObject(cause, seen, maxDepth, false);
  }
  const checked = toJsonValue(cause, "cause", maxDepth);
  return checked.ok ? checked.value : undefined;
}

function serializeErrorObject(error: Error, seen: Set<Error>, maxDepth: number, topLevel: boolean): RemoteSerializedError {
  seen.add(error);
  try {
    // Preserve standard Error fields plus a JSON-safe cause. Other
    // subclass-specific fields remain intentionally excluded until the
    // wire format defines a broader error metadata contract.
    const value: RemoteSerializedError = {
      name: safeStringFrom(() => error.name, "Error"),
      message: safeStringFrom(() => error.message, ""),
    };

    // Stack-read rule: best-effort, omitted on any failure.
    try {
      const stack = error.stack;
      if (typeof stack === "string") value.stack = stack;
    } catch {
      /* omit stack */
    }

    let rawCause: unknown;
    try {
      rawCause = getErrorCause(error);
    } catch {
      rawCause = undefined;
    }
    const cause = rawCause === undefined ? undefined : serializeErrorCause(rawCause, seen, maxDepth);

    // An application error's string `code` is forwarded (emission site A,
    // application-error row), but it MUST NOT repurpose a protocol code:
    // anything in the reserved `WC_BINDABLE_` namespace becomes
    // WC_BINDABLE_REMOTE_THROW. Only the top-level code is the envelope's
    // `error.code`; a nested cause's code is payload.
    const code = readStringCode(error);
    if (code !== undefined) {
      value.code = topLevel && RESERVED_CODE_PREFIX.test(code) ? REMOTE_THROW : code;
    }

    if (cause !== undefined) {
      value.cause = cause;
    }

    return value;
  } finally {
    seen.delete(error);
  }
}

function serializeThrownError(error: unknown, maxDepth: number): unknown {
  let serialized: unknown;
  if (isErrorInstance(error)) {
    serialized = serializeErrorObject(error, new Set(), maxDepth, true);
  } else {
    // Canonical mapping for non-Error throws: a fixed name, a safely
    // stringified message, and the thrown value as `cause` only when it is a
    // JsonValue. The thrown value's own fields never become envelope fields,
    // so a thrown `{ code: "WC_BINDABLE_DISPOSED" }` cannot set `error.code`.
    const canonical: RemoteSerializedError = {
      name: "NonErrorThrow",
      message: safeStringFrom(() => error, "<unstringifiable thrown value>"),
    };
    const checked = toJsonValue(error, "cause", maxDepth);
    if (checked.ok) canonical.cause = checked.value;
    serialized = canonical;
  }

  if (isSerializableAsThrowPayload(serialized)) {
    return serialized;
  }

  return createRemoteShellProxyError("Thrown value is not JSON-serializable", REMOTE_THROW);
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
  /**
   * Logger used for diagnostic output (dropped `set`/`cmd` frames, getter
   * failures, send failures, etc.). Defaults to `console.warn` /
   * `console.error`. Inject a structured logger in production.
   */
  logger?: Logger;
  /**
   * Nesting-depth resource limit for the values this shell SENDS — `sync` /
   * `update` values, `return` values and throw `cause`s (SPEC-extensions.md
   * § Design invariants, invariant 3 → "Resource limits during validation").
   * Deeper values risk exceeding `JSON.stringify`'s stack. Inbound values are
   * not depth-limited: the sender's limit is not negotiated, so a receiving
   * limit would silently drop writes the sender considered valid. Defaults to
   * 256. A positive integer, or `Infinity` to disable.
   */
  maxDepth?: number;
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
  private _logger: Logger;
  private _maxDepth: number;

  constructor(
    core: EventTarget,
    transport: ServerTransport,
    options: RemoteShellProxyOptions = {},
  ) {
    this._core = core;
    this._transport = transport;
    this._maxSyncUpdateBuffer = normalizeSyncBufferLimit(options.maxSyncUpdateBuffer);
    this._maxDepth = normalizeMaxDepth(options.maxDepth, "RemoteShellProxy");
    this._logger = resolveLogger(options.logger);

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
  private _readCurrentValues(): {
    values: Record<string, unknown>;
    getterFailures: string[];
    undefinedProperties: string[];
  } {
    const values: Record<string, unknown> = {};
    const getterFailures: string[] = [];
    const undefinedProperties: string[] = [];
    const coreRecord = this._core as unknown as Record<string, unknown>;
    for (const prop of this._declaration.properties) {
      try {
        const v = coreRecord[prop.name];
        if (v !== undefined) {
          const checked = toJsonValue(v, prop.name, this._maxDepth);
          if (checked.ok) {
            values[prop.name] = checked.value;
          } else {
            // Not a JsonValue: warn and drop it from the snapshot without a
            // state assertion. Listing the name in `getterFailures` is the
            // only wire signal that makes the consumer keep its last value
            // (§ getterFailures semantics); a bare omission would read as
            // "property not present" (§ Undefined enumeration).
            getterFailures.push(prop.name);
            this._logger.warn(
              `RemoteShellProxy: dropped sync value for "${prop.name}": ${checked.reason}`,
            );
          }
        } else {
          // Omit from `values` (to keep wire payload minimal and preserve
          // local bind() parity) but record the name explicitly so the
          // client can distinguish "currently undefined" from any other
          // reason a property is missing from `values`.
          undefinedProperties.push(prop.name);
        }
      } catch (err) {
        getterFailures.push(prop.name);
        this._logger.error(
          `RemoteShellProxy: getter for "${prop.name}" threw during sync:`,
          err,
        );
      }
    }
    return { values, getterFailures, undefinedProperties };
  }

  private _subscribeToCoreEvents(): UnbindFn {
    const cleanups: Array<() => void> = [];

    for (const prop of this._declaration.properties) {
      const getter = prop.getter ?? DEFAULT_GETTER;
      const handler = (event: Event) => {
        try {
          const value = getter(event);
          // Omit the `value` key entirely when the property transitions
          // to `undefined`. JSON cannot represent undefined and absent
          // key is the normative encoding per SPEC-extensions § Update
          // envelope value field. The consumer treats absent as
          // undefined on receipt.
          let message: ServerMessage;
          if (value === undefined) {
            message = { type: "update", name: prop.name };
          } else {
            const checked = toJsonValue(value, prop.name, this._maxDepth);
            if (!checked.ok) {
              // Invariant 3: warn and drop; the consumer keeps the last
              // value it received. Never coerced, never replaced by null.
              this._logger.warn(
                `RemoteShellProxy: dropped update for "${prop.name}": ${checked.reason}`,
              );
              return;
            }
            message = { type: "update", name: prop.name, value: checked.value };
          }
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
              this._logger.warn(
                `RemoteShellProxy: sync update buffer exceeded maxSyncUpdateBuffer=${this._maxSyncUpdateBuffer}; a runaway getter side-effect may be emitting updates during sync snapshot build`,
              );
            }
            return;
          }

          this._safeSend(message, `update for "${prop.name}"`);
        } catch (err) {
          this._logger.error(
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
      this._logger.error(`RemoteShellProxy: failed to send ${context}:`, err);
      return false;
    }
  }

  private _sendSyncResponse(): void {
    this._isBuildingSyncSnapshot = true;
    let sent = false;

    try {
      const { values, getterFailures, undefinedProperties } = this._readCurrentValues();
      sent = this._safeSend({
        type: "sync",
        values,
        capabilities: REMOTE_CAPABILITIES,
        // Always include the fingerprint — it lets the client detect a stale
        // or mismatched declaration cached on its side (different package
        // version, partial deploy, etc.) before the mismatch surfaces as a
        // per-message rejection. See SPEC-extensions.md § Declaration
        // fingerprint.
        declarationFingerprint: buildDeclarationFingerprint(this._declaration),
        ...(getterFailures.length > 0 ? { getterFailures } : {}),
        ...(undefinedProperties.length > 0 ? { undefinedProperties } : {}),
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
        this._handleSet(msg);
        break;
      }
      case "cmd": {
        this._handleCmd(msg);
        break;
      }
    }
  }

  /** Reply with a `throw` to a well-formed id, otherwise warn and drop. */
  private _rejectInbound(
    msg: { id?: unknown },
    error: RemoteSerializedError,
    context: string,
    dropWarning: string,
  ): void {
    const id = wellFormedId(msg);
    if (id !== null) {
      this._safeSend({ type: "throw", id, error }, `throw response for ${context}`);
      return;
    }
    this._logger.warn(`RemoteShellProxy: ${dropWarning}`);
  }

  private _handleSet(msg: Extract<ClientMessage, { type: "set" }>): void {
    // An id that is present but not a non-empty string is malformed: the
    // producer cannot echo it back, so the message is logged and dropped
    // before anything touches the Core (§ Message types — client → server).
    if (msg.id !== undefined && !hasWellFormedId(msg)) {
      this._logger.warn(`RemoteShellProxy: ignored set for input "${msg.name}" with a malformed id`);
      return;
    }
    const context = `input "${msg.name}"`;
    if (!this._allowedInputs.has(msg.name)) {
      this._rejectInbound(
        msg,
        createRemoteShellProxyError(`Input "${msg.name}" is not declared in wcBindable.inputs`, "WC_BINDABLE_UNDECLARED_INPUT"),
        context,
        `ignored set for undeclared input "${msg.name}"`,
      );
      return;
    }
    // Reserved names are rejected while building _allowedInputs, so this
    // should be unreachable for normal declarations. Keep the guard at the
    // assignment boundary as defense in depth in case a malformed message,
    // mutated declaration, or JS-level private-field escape bypasses the
    // constructor-time validation.
    if (isReservedRemoteName(msg.name)) {
      this._rejectInbound(
        msg,
        createRemoteShellProxyError(`Input "${msg.name}" is reserved and cannot be assigned remotely`, "WC_BINDABLE_RESERVED_NAME"),
        context,
        `ignored set for reserved input "${msg.name}"`,
      );
      return;
    }
    // Legacy acceptance (SPEC-extensions.md § Design invariants, invariant 3):
    // consumers that predate the JsonValue gate encode `set(name, undefined)`
    // as a `set` without `value` (JSON transports) or with `value: undefined`
    // (by-reference transports). Both are applied as an assignment of
    // `undefined`; a current consumer-side proxy never sends either. Any other
    // value is validated before the Core is touched.
    const value = msg.value;
    if (value !== undefined) {
      const invalidValue = describeNonJsonValue(value, "value");
      if (invalidValue !== null) {
        this._rejectInbound(
          msg,
          createRemoteShellProxyError(`Input "${msg.name}" value is not a JsonValue: ${invalidValue}`, "WC_BINDABLE_INVALID_JSON_VALUE"),
          context,
          `ignored set for input "${msg.name}": ${invalidValue}`,
        );
        return;
      }
    }
    const id = wellFormedId(msg);
    try {
      (this._core as unknown as Record<string, unknown>)[msg.name] = value;
      if (id !== null) {
        this._safeSend({ type: "return", id, value: undefined }, `return response for ${context}`);
      }
    } catch (err) {
      if (id !== null) {
        this._safeSend({
          type: "throw",
          id,
          error: serializeThrownError(err, this._maxDepth),
        }, `throw response for ${context}`);
        return;
      }

      this._logger.error(
        `RemoteShellProxy: setter for "${msg.name}" threw:`,
        err,
      );
    }
  }

  private _handleCmd(msg: Extract<ClientMessage, { type: "cmd" }>): void {
    // A cmd has nowhere to deliver its result without a well-formed id.
    if (!hasWellFormedId(msg)) {
      this._logger.warn(`RemoteShellProxy: ignored cmd "${msg.name}" with a malformed id`);
      return;
    }
    const id = msg.id;
    const context = `command "${msg.name}"`;
    if (!this._allowedCommands.has(msg.name)) {
      this._safeSend({
        type: "throw",
        id,
        error: createRemoteShellProxyError(
          `Command "${msg.name}" is not declared in wcBindable.commands`,
          "WC_BINDABLE_UNDECLARED_COMMAND",
        ),
      }, `throw response for ${context}`);
      return;
    }
    // Validate before the method lookup: reading `core[name]` can run an
    // accessor on the Core, and validation MUST precede any Core access.
    const invalidArgs = describeNonJsonArguments(msg.args);
    if (invalidArgs !== null) {
      this._safeSend({
        type: "throw",
        id,
        error: createRemoteShellProxyError(
          `Command "${msg.name}" args are not JsonValue: ${invalidArgs}`,
          Array.isArray(msg.args) ? "WC_BINDABLE_INVALID_JSON_VALUE" : "WC_BINDABLE_PROTOCOL_ERROR",
        ),
      }, `throw response for ${context}`);
      return;
    }
    const method = (this._core as unknown as Record<string, (...args: unknown[]) => unknown>)[msg.name];
    if (typeof method !== "function") {
      this._safeSend({
        type: "throw",
        id,
        // Declared but not implemented: the Core is at fault, as if calling
        // it had thrown a TypeError.
        error: createRemoteShellProxyError(`Method "${msg.name}" not found on Core`, REMOTE_THROW),
      }, `throw response for ${context}`);
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
            this._sendReturn(id, msg.name, value);
          })
          .catch((err) => {
            if (this._disposed) return;
            this._safeSend({
              type: "throw",
              id,
              error: serializeThrownError(err, this._maxDepth),
            }, `throw response for ${context}`);
          });
      } else {
        this._sendReturn(id, msg.name, result);
      }
    } catch (err) {
      this._safeSend({
        type: "throw",
        id,
        error: serializeThrownError(err, this._maxDepth),
      }, `throw response for ${context}`);
    }
  }

  /**
   * Emit the `return` for a settled command. `undefined` keeps the absent-key
   * encoding (§ Return envelope value field); any other value is validated
   * and copied, and a non-JsonValue becomes a `WC_BINDABLE_INVALID_RETURN_VALUE`
   * `throw` instead of being reshaped by JSON.stringify (or leaving the caller
   * to time out when serialization throws).
   */
  private _sendReturn(id: string, name: string, value: unknown): void {
    if (value === undefined) {
      this._safeSend({ type: "return", id, value: undefined }, `return response for command "${name}"`);
      return;
    }
    const checked = toJsonValue(value, "return", this._maxDepth);
    if (!checked.ok) {
      this._safeSend({
        type: "throw",
        id,
        error: createRemoteShellProxyError(
          `Command "${name}" returned a value that is not a JsonValue: ${checked.reason}`,
          "WC_BINDABLE_INVALID_RETURN_VALUE",
        ),
      }, `throw response for command "${name}"`);
      return;
    }
    this._safeSend({ type: "return", id, value: checked.value }, `return response for command "${name}"`);
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
