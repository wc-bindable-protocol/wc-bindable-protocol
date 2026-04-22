import { describe, it, expect } from "vitest";
import { InMemoryFlagProvider } from "../src/providers/InMemoryFlagProvider";
import type { FlagIdentity, FlagMap } from "../src/types";

const ID_ALICE: FlagIdentity = { userId: "alice", attrs: { role: "admin" } };
const ID_BOB: FlagIdentity = { userId: "bob", attrs: { role: "user" } };

describe("InMemoryFlagProvider", () => {
  it("constructs with no flags", async () => {
    const p = new InMemoryFlagProvider();
    const flags = await p.identify(ID_ALICE);
    expect(flags).toEqual({});
    expect(Object.isFrozen(flags)).toBe(true);
  });

  it("identify returns evaluated defaults when no rules match", async () => {
    const p = new InMemoryFlagProvider({
      flags: [
        { key: "a", defaultValue: true },
        { key: "b", defaultValue: "x" },
      ],
    });
    const flags = await p.identify(ID_ALICE);
    expect(flags).toEqual({ a: true, b: "x" });
    expect(Object.isFrozen(flags)).toBe(true);
  });

  it("rules pick the first matching entry per flag", async () => {
    const p = new InMemoryFlagProvider({
      flags: [
        {
          key: "beta",
          defaultValue: false,
          rules: [
            { key: "beta", value: true, predicate: (id) => id.attrs?.role === "admin" },
            { key: "beta", value: false, predicate: () => true },
          ],
        },
      ],
    });
    expect((await p.identify(ID_ALICE)).beta).toBe(true);
    expect((await p.identify(ID_BOB)).beta).toBe(false);
  });

  it("reload() re-evaluates", async () => {
    const p = new InMemoryFlagProvider({ flags: [{ key: "x", defaultValue: 1 }] });
    expect(await p.reload(ID_ALICE)).toEqual({ x: 1 });
  });

  it("subscribe delivers updates when setFlag is called", async () => {
    const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: false }] });
    const received: FlagMap[] = [];
    const unsubscribe = p.subscribe(ID_ALICE, (m) => received.push(m));

    p.setFlag("a", true);
    p.setFlag("b", "v");
    unsubscribe();
    p.setFlag("a", false);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ a: true });
    expect(received[1]).toEqual({ a: true, b: "v" });
  });

  it("multiple subscribers for the same identity all get notified", async () => {
    const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: false }] });
    const a: FlagMap[] = [];
    const b: FlagMap[] = [];
    p.subscribe(ID_ALICE, (m) => a.push(m));
    p.subscribe(ID_ALICE, (m) => b.push(m));
    p.setFlag("a", true);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("unsubscribing one of several subscribers leaves the bucket intact", () => {
    const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: false }] });
    const a: FlagMap[] = [];
    const b: FlagMap[] = [];
    const unsubA = p.subscribe(ID_ALICE, (m) => a.push(m));
    p.subscribe(ID_ALICE, (m) => b.push(m));
    unsubA();
    p.setFlag("a", true);
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it("unsubscribe twice is a no-op", () => {
    const p = new InMemoryFlagProvider();
    const unsub = p.subscribe(ID_ALICE, () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it("unsubscribe for a non-existent identity is a no-op", () => {
    const p = new InMemoryFlagProvider();
    const unsub = p.subscribe(ID_ALICE, () => {});
    unsub();
    // Dispose the bucket, then re-run unsub to hit the "no bucket" branch.
    expect(() => unsub()).not.toThrow();
  });

  it("setFlags replaces the full flag set", async () => {
    const p = new InMemoryFlagProvider({ flags: [{ key: "old", defaultValue: true }] });
    const received: FlagMap[] = [];
    p.subscribe(ID_ALICE, (m) => received.push(m));
    p.setFlags([{ key: "new", defaultValue: 42 }]);
    expect(received[0]).toEqual({ new: 42 });
    expect(await p.identify(ID_ALICE)).toEqual({ new: 42 });
  });

  it("setFlag preserves existing rules when only defaultValue is replaced", () => {
    const p = new InMemoryFlagProvider({
      flags: [{
        key: "beta",
        defaultValue: false,
        rules: [{ key: "beta", value: true, predicate: (id) => id.userId === "alice" }],
      }],
    });
    const received: FlagMap[] = [];
    p.subscribe(ID_BOB, (m) => received.push(m));
    p.setFlag("beta", false);
    // Bob doesn't match rule; default stays applied (still false)
    expect(received[0]).toEqual({ beta: false });
  });

  it("accepts the `initial` parameter on the concrete class (FlagProvider contract parity)", () => {
    // Regression guard: the concrete InMemoryFlagProvider.subscribe used
    // to have only 2 parameters even though the FlagProvider interface
    // declared 3. Calling it with a third argument in concrete-type
    // code would fail type-check. `initial` is intentionally ignored
    // by this provider, but the arity must match.
    const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: true }] });
    const received: FlagMap[] = [];
    const initial: FlagMap = { a: true };
    // The 3-arg form must compile and behave identically to the 2-arg form.
    const unsub = p.subscribe(ID_ALICE, (m) => received.push(m), initial);
    p.setFlag("a", false);
    unsub();
    p.setFlag("a", true);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ a: false });
  });

  it("evaluated maps are deep-frozen, isolating rule-defined values", async () => {
    // Regression guard for [R1-06]: the older `Object.freeze(out)` did
    // shallow-freeze only. A consumer writing `map.x.enabled = false`
    // on a `{ enabled, value }`-shaped flag (or pushing into a
    // rule-defined array) would silently succeed AND contaminate
    // the Provider's source-of-truth rule definition, since the
    // value slots were passed through by reference. deepCloneAndFreeze
    // isolates both sides.
    const shared = { enabled: true, value: "v1" };
    const sharedArr = ["a", "b"];
    const p = new InMemoryFlagProvider({
      flags: [
        { key: "obj", defaultValue: shared },
        { key: "arr", defaultValue: sharedArr },
      ],
    });
    const map = await p.identify(ID_ALICE);

    // Outer map frozen.
    expect(Object.isFrozen(map)).toBe(true);
    // Nested values also frozen — no shallow-freeze escape hatch.
    expect(Object.isFrozen(map.obj)).toBe(true);
    expect(Object.isFrozen(map.arr)).toBe(true);
    expect(() => {
      (map.obj as { enabled: boolean }).enabled = false;
    }).toThrow(TypeError);
    expect(() => {
      (map.arr as string[]).push("c");
    }).toThrow(TypeError);

    // Source rule definitions remain mutable AND un-contaminated — we
    // cloned on the way out, so the Provider's own refs stay editable.
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(sharedArr)).toBe(false);
    shared.enabled = false;
    expect((map.obj as { enabled: boolean }).enabled).toBe(true);
  });

  it("dispose() clears subscribers and flags", async () => {
    const p = new InMemoryFlagProvider({ flags: [{ key: "a", defaultValue: true }] });
    let count = 0;
    p.subscribe(ID_ALICE, () => { count++; });
    p.dispose();
    // Subscribers cleared — a later setFlag must not call onChange.
    p.setFlag("b", true);
    expect(count).toBe(0);
  });
});
