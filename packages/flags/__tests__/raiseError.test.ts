import { describe, it, expect } from "vitest";
import { raiseError } from "../src/raiseError";

describe("raiseError", () => {
  it("throws an Error prefixed with the package name", () => {
    expect(() => raiseError("boom")).toThrow("[@wc-bindable/flags] boom");
  });

  it("the thrown value is an Error instance", () => {
    try {
      raiseError("x");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      return;
    }
    throw new Error("raiseError did not throw");
  });
});
