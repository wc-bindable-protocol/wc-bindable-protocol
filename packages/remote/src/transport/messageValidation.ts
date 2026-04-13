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
      // The `value` key is optional on the wire: JSON.stringify drops
      // `value: undefined`, so an absent key is the only way to transport an
      // undefined assignment. Reading `msg.value` yields `undefined` in that
      // case, matching the sender's intent.
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
        (value.getterFailures === undefined || isStringArray(value.getterFailures))
      );
    case "update":
      // See note on "set": an absent `value` key represents an undefined
      // update, since JSON.stringify cannot transmit `value: undefined`.
      return isValidRemoteName(value.name);
    case "return":
    case "throw":
      return typeof value.id === "string";
    default:
      return false;
  }
}