import { describe, expect, it } from "vitest";
import {
  isClientMessage,
  isServerMessage,
  isReservedRemoteName,
  RESERVED_REMOTE_NAMES,
} from "../src/transport/messageValidation.js";

describe("messageValidation", () => {
  it("recognizes reserved remote names", () => {
    for (const name of RESERVED_REMOTE_NAMES) {
      expect(isReservedRemoteName(name)).toBe(true);
    }
    expect(isReservedRemoteName("value")).toBe(false);
  });

  it("rejects non-record client messages and unknown client message types", () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage([])).toBe(false);
    expect(isClientMessage({})).toBe(false);
    expect(isClientMessage({ type: "unknown" })).toBe(false);
  });

  it("validates client set/cmd shapes including reserved names and required args", () => {
    expect(isClientMessage({ type: "set", name: "url" })).toBe(true);
    expect(isClientMessage({ type: "set", name: "url", id: 1 })).toBe(false);
    expect(isClientMessage({ type: "set", name: "", value: 1 })).toBe(false);
    expect(isClientMessage({ type: "set", name: "__proto__", value: 1 })).toBe(false);

    expect(isClientMessage({ type: "cmd", name: "doFetch", id: "1", args: [] })).toBe(true);
    expect(isClientMessage({ type: "cmd", name: "", id: "1", args: [] })).toBe(false);
    expect(isClientMessage({ type: "cmd", name: "constructor", id: "1", args: [] })).toBe(false);
    expect(isClientMessage({ type: "cmd", name: "doFetch", id: "", args: [] })).toBe(false);
    expect(isClientMessage({ type: "cmd", name: "doFetch", id: "1", args: "nope" })).toBe(false);
  });

  it("rejects non-record server messages and unknown server message types", () => {
    expect(isServerMessage(null)).toBe(false);
    expect(isServerMessage([])).toBe(false);
    expect(isServerMessage({})).toBe(false);
    expect(isServerMessage({ type: "unknown" })).toBe(false);
  });

  it("validates sync/update/return/throw server messages", () => {
    const reservedSyncValues = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    expect(isServerMessage({ type: "sync", values: null })).toBe(false);
    expect(isServerMessage({
      type: "sync",
      values: { value: 1 },
      capabilities: { setAck: true },
      getterFailures: ["value"],
    })).toBe(true);
    expect(isServerMessage({
      type: "sync",
      values: reservedSyncValues,
    })).toBe(false);
    expect(isServerMessage({
      type: "sync",
      values: {},
      capabilities: { setAck: "yes" },
    })).toBe(false);
    expect(isServerMessage({
      type: "sync",
      values: {},
      getterFailures: [1],
    })).toBe(false);

    expect(isServerMessage({
      type: "sync",
      values: {},
      undefinedProperties: ["loading", "value"],
    })).toBe(true);
    expect(isServerMessage({
      type: "sync",
      values: {},
      undefinedProperties: "loading",
    })).toBe(false);
    expect(isServerMessage({
      type: "sync",
      values: {},
      undefinedProperties: [1, 2],
    })).toBe(false);

    expect(isServerMessage({ type: "update", name: "value" })).toBe(true);
    expect(isServerMessage({ type: "update", name: "prototype" })).toBe(false);
    expect(isServerMessage({ type: "return", id: "1", value: 42 })).toBe(true);
    expect(isServerMessage({ type: "throw", id: "2", error: "boom" })).toBe(true);
    expect(isServerMessage({ type: "return", id: 1 })).toBe(false);
    expect(isServerMessage({ type: "throw", id: 2 })).toBe(false);
  });
});