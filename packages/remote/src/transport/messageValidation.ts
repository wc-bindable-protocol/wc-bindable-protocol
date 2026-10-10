import type { ClientMessage, RemoteCapabilities, ServerMessage } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export const RESERVED_REMOTE_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export function isReservedRemoteName(name: string): boolean {
  return RESERVED_REMOTE_NAMES.has(name);
}

function isValidRemoteName(value: unknown): value is string {
  return isNonEmptyString(value) && !RESERVED_REMOTE_NAMES.has(value);
}

function isServerSyncValues(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  // Per-key check: object keys travel over the wire just like `set.name` /
  // `cmd.name`, and assigning `values["__proto__"] = x` into the cache object
  // mutates its prototype. Reject reserved names here so the whole sync frame
  // is dropped before it reaches the proxy's cache writes.
  for (const key of Object.keys(value)) {
    if (RESERVED_REMOTE_NAMES.has(key)) return false;
  }
  return true;
}

function isRemoteCapabilities(value: unknown): value is RemoteCapabilities {
  return (
    isRecord(value) &&
    (value.setAck === undefined || typeof value.setAck === "boolean")
  );
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "sync":
      return true;
    case "set":
      // `value` is required by the wire schema, but a `set` without it is
      // let through: the producer-side shell applies it as the legacy encoding
      // of `set(name, undefined)` from consumers that predate the JsonValue
      // gate. Malformed ids are let through too, so the shell can apply its
      // single well-formed-id rule (log and drop).
      return (
        isValidRemoteName(value.name) &&
        (value.id === undefined || typeof value.id === "string")
      );
    case "cmd":
      return (
        isValidRemoteName(value.name) &&
        isNonEmptyString(value.id) &&
        isUnknownArray(value.args)
      );
    default:
      return false;
  }
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "sync":
      return (
        isServerSyncValues(value.values) &&
        (value.capabilities === undefined || isRemoteCapabilities(value.capabilities)) &&
        (value.getterFailures === undefined || isStringArray(value.getterFailures)) &&
        (value.undefinedProperties === undefined || isStringArray(value.undefinedProperties))
      );
    case "update":
      // An absent `value` key represents a transition to `undefined`
      // (SPEC-extensions.md § Update envelope value field).
      return isValidRemoteName(value.name);
    case "return":
    case "throw":
      return typeof value.id === "string";
    default:
      return false;
  }
}