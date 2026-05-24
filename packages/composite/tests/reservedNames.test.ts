import { describe, it, expect } from "vitest";
import {
  isReservedComposedName,
  isReservedSourceId,
  reservedComposedNameReason,
} from "../src/index.js";

describe("isReservedComposedName", () => {
  it("rejects the prototype-pollution-prone names", () => {
    expect(isReservedComposedName("__proto__")).toBe(true);
    expect(isReservedComposedName("constructor")).toBe(true);
    expect(isReservedComposedName("prototype")).toBe(true);
  });

  it("rejects fixed shell-API members", () => {
    expect(isReservedComposedName("addEventListener")).toBe(true);
    expect(isReservedComposedName("removeEventListener")).toBe(true);
    expect(isReservedComposedName("dispatchEvent")).toBe(true);
    expect(isReservedComposedName("dispose")).toBe(true);
  });

  it("rejects the @wc-bindable/ wire prefix case-insensitively", () => {
    expect(isReservedComposedName("@wc-bindable/foo")).toBe(true);
    expect(isReservedComposedName("@WC-BINDABLE/foo")).toBe(true);
    expect(isReservedComposedName("@Wc-BiNdAbLe/x")).toBe(true);
  });

  it("accepts ordinary composed names, including dotted defaults", () => {
    expect(isReservedComposedName("s3.progress")).toBe(false);
    expect(isReservedComposedName("ai.answer")).toBe(false);
    expect(isReservedComposedName("value")).toBe(false);
  });

  it("reports a human-readable reason", () => {
    expect(reservedComposedNameReason("__proto__")).toContain("pollution");
    expect(reservedComposedNameReason("dispatchEvent")).toContain("fixed shell API");
    expect(reservedComposedNameReason("@wc-bindable/x")).toContain("@wc-bindable/");
    expect(reservedComposedNameReason("ok")).toBeUndefined();
  });
});

describe("isReservedSourceId", () => {
  it("rejects empty, dotted, and pollution-prone source ids", () => {
    expect(isReservedSourceId("")).toBe(true);
    expect(isReservedSourceId("a.b")).toBe(true);
    expect(isReservedSourceId("__proto__")).toBe(true);
    expect(isReservedSourceId("constructor")).toBe(true);
  });

  it("accepts ordinary source ids", () => {
    expect(isReservedSourceId("s3")).toBe(false);
    expect(isReservedSourceId("ai")).toBe(false);
  });
});
