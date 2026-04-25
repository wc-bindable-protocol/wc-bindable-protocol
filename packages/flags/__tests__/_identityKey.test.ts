import { describe, it, expect } from "vitest";
import { identityKey, stableStringify, stableValue } from "../src/providers/_identityKey";

describe("_identityKey helpers", () => {
  describe("stableStringify", () => {
    it("sorts keys at every depth so two maps compare equal regardless of insertion order", () => {
      const a = stableStringify({ b: 1, a: { y: 2, x: 1 } });
      const b = stableStringify({ a: { x: 1, y: 2 }, b: 1 });
      expect(a).toBe(b);
    });

    it("distinguishes different values at the same key set", () => {
      expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    });
  });

  describe("stableValue", () => {
    it("serializes primitives via JSON.stringify", () => {
      expect(stableValue(null)).toBe("null");
      expect(stableValue(1)).toBe("1");
      expect(stableValue("x")).toBe('"x"');
      expect(stableValue(true)).toBe("true");
    });

    it("preserves array element order", () => {
      expect(stableValue(["b", "a", "c"])).toBe('["b","a","c"]');
    });
  });

  describe("circular reference handling", () => {
    // Regression guard for [R1-05]: `FlagIdentity.attrs` is user-
    // supplied, so an accidental cycle must not blow the stack. The
    // guard replaces any node already on the current recursion path
    // with the "[Circular]" sentinel and keeps walking.

    it("does not stack-overflow on a self-referential attrs object", () => {
      const attrs: Record<string, unknown> = { kind: "user" };
      attrs.self = attrs;
      // Guarded — must terminate.
      const out = stableStringify(attrs);
      expect(out).toContain('"kind":"user"');
      expect(out).toContain('"self":"[Circular]"');
    });

    it("tolerates deeper cycles inside nested objects", () => {
      const inner: Record<string, unknown> = { name: "alice" };
      const outer: Record<string, unknown> = { inner };
      inner.back = outer;
      const out = stableStringify(outer);
      expect(out).toContain('"name":"alice"');
      expect(out).toContain('"back":"[Circular]"');
    });

    it("tolerates cycles through arrays", () => {
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => stableValue(arr)).not.toThrow();
      expect(stableValue(arr)).toBe('["[Circular]"]');
    });

    it("shared non-ancestor references are NOT flagged as circular", () => {
      // Two sibling branches both pointing at the same leaf object
      // is a DAG, not a cycle — must serialize normally.
      const shared = { v: 1 };
      const obj = { a: shared, b: shared };
      const out = stableStringify(obj);
      // Both siblings carry the same serialized form.
      expect(out).toBe('{"a":{"v":1},"b":{"v":1}}');
    });

    it("produces stable keys for otherwise-identical identities with cycles", () => {
      // `identityKey` uses stableStringify under the hood. Two
      // identity objects with the same shape — cycles and all —
      // should key identically, otherwise bucket dedupe would
      // collapse under cycle-containing inputs.
      const makeAttrs = (): Record<string, unknown> => {
        const a: Record<string, unknown> = { email: "a@x" };
        a.self = a;
        return a;
      };
      const k1 = identityKey({ userId: "alice", attrs: makeAttrs() });
      const k2 = identityKey({ userId: "alice", attrs: makeAttrs() });
      expect(k1).toBe(k2);
    });
  });
});
