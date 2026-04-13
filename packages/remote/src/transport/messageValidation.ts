import type { ClientMessage, ServerMessage } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isServerSyncValues(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
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
        typeof value.name === "string" &&
        (value.id === undefined || typeof value.id === "string")
      );
    case "cmd":
      return (
        typeof value.name === "string" &&
        typeof value.id === "string" &&
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
      return isServerSyncValues(value.values);
    case "update":
      // See note on "set": an absent `value` key represents an undefined
      // update, since JSON.stringify cannot transmit `value: undefined`.
      return typeof value.name === "string";
    case "return":
    case "throw":
      return typeof value.id === "string";
    default:
      return false;
  }
}