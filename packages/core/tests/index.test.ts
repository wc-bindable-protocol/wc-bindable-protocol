import { describe, it, expect, vi } from "vitest";
import {
  bind,
  isWcBindable,
  getWcBindableDeclaration,
  MIN_COMPATIBLE_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
} from "../src/index.js";
import type { WcBindableDeclaration } from "../src/index.js";

function createBindableElement(decl: WcBindableDeclaration): HTMLElement {
  class TestElement extends HTMLElement {
    static wcBindable = decl;
  }
  const tag = `test-el-${Math.random().toString(36).slice(2, 8)}`;
  customElements.define(tag, TestElement);
  return document.createElement(tag);
}

const validDeclaration: WcBindableDeclaration = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "value", event: "test:value-changed" },
  ],
};

describe("isWcBindable", () => {
  it("returns true for a valid wc-bindable element", () => {
    const el = createBindableElement(validDeclaration);
    expect(isWcBindable(el)).toBe(true);
  });

  it("returns false for a plain HTMLElement", () => {
    const el = document.createElement("div");
    expect(isWcBindable(el)).toBe(false);
  });

  it("returns false when protocol does not match", () => {
    const el = createBindableElement({
      ...validDeclaration,
      protocol: "other" as "wc-bindable",
    });
    expect(isWcBindable(el)).toBe(false);
  });

  it("accepts future protocol versions (forward-compat)", () => {
    const el = createBindableElement({
      ...validDeclaration,
      version: MIN_COMPATIBLE_VERSION + 1,
    });
    expect(isWcBindable(el)).toBe(true);
  });

  it("exposes SUPPORTED_PROTOCOL_VERSION as a deprecated alias for MIN_COMPATIBLE_VERSION", () => {
    expect(SUPPORTED_PROTOCOL_VERSION).toBe(MIN_COMPATIBLE_VERSION);
  });

  it("pins MIN_COMPATIBLE_VERSION to 1 (the protocol-wide minimum, NOT adapter-specific)", () => {
    // SPEC.md § Versioning forbids raising this constant within the
    // "wc-bindable" protocol identifier — adapters MUST accept every
    // version >= 1 regardless of when they were built.
    expect(MIN_COMPATIBLE_VERSION).toBe(1);
  });

  it("rejects versions below the protocol-wide minimum (< 1)", () => {
    const el = createBindableElement({
      ...validDeclaration,
      version: 0,
    });
    expect(isWcBindable(el)).toBe(false);
  });

  it("rejects non-integer versions", () => {
    const el = createBindableElement({
      ...validDeclaration,
      version: 1.5,
    });
    expect(isWcBindable(el)).toBe(false);
  });
});

describe("getWcBindableDeclaration", () => {
  it("returns the declaration for a valid target", () => {
    const el = createBindableElement(validDeclaration);
    const decl = getWcBindableDeclaration(el);
    expect(decl?.protocol).toBe("wc-bindable");
    expect(decl?.properties[0].name).toBe("value");
  });

  it("returns undefined for non-bindable targets", () => {
    expect(getWcBindableDeclaration(document.createElement("div"))).toBeUndefined();
  });

  it("returns undefined when protocol mismatches", () => {
    const el = createBindableElement({
      ...validDeclaration,
      protocol: "other" as "wc-bindable",
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when version is below MIN_COMPATIBLE_VERSION", () => {
    const el = createBindableElement({ ...validDeclaration, version: 0 });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when properties is not an array", () => {
    const el = createBindableElement({
      ...validDeclaration,
      properties: "nope" as unknown as never,
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when a property descriptor is missing name", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ event: "test:e" } as unknown as { name: string; event: string }],
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when a property descriptor's getter is not a function", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "test:e", getter: 42 as unknown as () => unknown }],
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when properties contain duplicate names", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "test:a" },
        { name: "value", event: "test:b" },
      ],
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when inputs contain duplicate names", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "test:e" }],
      inputs: [{ name: "url" }, { name: "url" }],
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when commands contain duplicate names", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "test:e" }],
      commands: [{ name: "fetch" }, { name: "fetch" }],
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("accepts declarations whose inputs/commands are absent (treated as empty)", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "test:e" }],
    });
    expect(getWcBindableDeclaration(el)).not.toBeUndefined();
  });

  it("accepts properties: [] (commands-only headless target is bindable)", () => {
    class CommandsOnly extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "ping" }],
      };
    }
    const t = new CommandsOnly();
    expect(getWcBindableDeclaration(t)).not.toBeUndefined();
    expect(isWcBindable(t)).toBe(true);
    // bind() should successfully no-op-but-not-error: no listeners, no
    // initial sync, returns a real cleanup function.
    const unbind = bind(t, () => { throw new Error("no event possible"); });
    expect(typeof unbind).toBe("function");
    unbind();
  });

  it("does not throw for pathological targets (null-prototype constructor reference)", () => {
    // EventTarget with constructor swapped out — Object.create(null) would not
    // satisfy the EventTarget signature, so simulate the "no ctor" case via a
    // proxy that returns undefined for .constructor access.
    const t = new Proxy(new EventTarget(), {
      get(target, prop, receiver) {
        if (prop === "constructor") return undefined;
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(() => getWcBindableDeclaration(t)).not.toThrow();
    expect(getWcBindableDeclaration(t)).toBeUndefined();
    expect(isWcBindable(t)).toBe(false);
  });

  it("accepts arbitrary unknown inputs without throwing (null / primitives / plain objects)", () => {
    // SPEC.md § Normative TypeScript surface: parameter type is `unknown`
    // precisely so callers can probe any input.
    for (const probe of [null, undefined, 0, "string", true, Symbol("x"), {}, [], new Map()]) {
      expect(() => getWcBindableDeclaration(probe as unknown as EventTarget)).not.toThrow();
      expect(getWcBindableDeclaration(probe as unknown as EventTarget)).toBeUndefined();
      expect(isWcBindable(probe as unknown as EventTarget)).toBe(false);
    }
  });

  it("rejects targets that have a valid declaration but lack EventTarget capability", () => {
    // A plain object with the static-fields shape would pass the schema
    // check but bind() would throw on addEventListener. The capability
    // check up front rejects it so isWcBindable() and bind() agree.
    class NotAnEventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: "test:e" }],
      };
    }
    const fake = new NotAnEventTarget() as unknown as EventTarget;
    expect(getWcBindableDeclaration(fake)).toBeUndefined();
    expect(isWcBindable(fake)).toBe(false);
  });
});

describe("bind", () => {
  it("calls onUpdate when the declared event is dispatched", () => {
    const el = createBindableElement(validDeclaration);
    const onUpdate = vi.fn();

    bind(el, onUpdate);
    el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "hello" }));

    expect(onUpdate).toHaveBeenCalledWith("value", "hello");
  });

  it("uses default getter (e.detail) when getter is omitted", () => {
    const el = createBindableElement(validDeclaration);
    const onUpdate = vi.fn();

    bind(el, onUpdate);
    el.dispatchEvent(new CustomEvent("test:value-changed", { detail: 42 }));

    expect(onUpdate).toHaveBeenCalledWith("value", 42);
  });

  it("uses custom getter when provided", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [
        {
          name: "checked",
          event: "test:checked-changed",
          getter: (e) => (e as CustomEvent).detail.checked,
        },
      ],
    });
    const onUpdate = vi.fn();

    bind(el, onUpdate);
    el.dispatchEvent(
      new CustomEvent("test:checked-changed", { detail: { checked: true } }),
    );

    expect(onUpdate).toHaveBeenCalledWith("checked", true);
  });

  it("handles multiple properties", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "test:value-changed" },
        { name: "disabled", event: "test:disabled-changed" },
      ],
    });
    const onUpdate = vi.fn();

    bind(el, onUpdate);
    el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "a" }));
    el.dispatchEvent(new CustomEvent("test:disabled-changed", { detail: true }));

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("value", "a");
    expect(onUpdate).toHaveBeenCalledWith("disabled", true);
  });

  it("returns an unbind function that removes all listeners", () => {
    const el = createBindableElement(validDeclaration);
    const onUpdate = vi.fn();

    const unbind = bind(el, onUpdate);
    unbind();
    el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "ignored" }));

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("returns a no-op function for non-bindable elements", () => {
    const el = document.createElement("div");
    const onUpdate = vi.fn();

    const unbind = bind(el, onUpdate);

    expect(typeof unbind).toBe("function");
    unbind(); // should not throw
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("cleans up listeners when initial-sync throws (no leak)", () => {
    const el = createBindableElement(validDeclaration);
    (el as unknown as Record<string, unknown>).value = "initial";

    // onUpdate throws during the synchronous initial sync. bind() MUST
    // tear down the listener it just installed and rethrow.
    const onUpdate = vi.fn(() => {
      throw new Error("consumer blew up");
    });

    expect(() => bind(el, onUpdate)).toThrow("consumer blew up");

    // If the listener leaked, this dispatch would call onUpdate again.
    const onUpdateAfter = vi.fn();
    onUpdate.mockImplementation(onUpdateAfter);
    el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "post-leak-check" }));
    expect(onUpdateAfter).not.toHaveBeenCalled();
  });

  it("treats a declaration with duplicate property names as invalid — both isWcBindable and bind agree", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "test:value-changed" },
        { name: "value", event: "test:value-other" }, // duplicate name
      ],
    });
    (el as unknown as Record<string, unknown>).value = "x";
    const onUpdate = vi.fn();

    // SPEC.md § Discovery API requires isWcBindable() to return false here,
    // not the older "true + bind no-ops" split.
    expect(isWcBindable(el)).toBe(false);

    const unbind = bind(el, onUpdate);
    el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "y" }));
    el.dispatchEvent(new CustomEvent("test:value-other", { detail: "z" }));
    unbind();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("synchronizes initial property values on bind", () => {
    const el = createBindableElement(validDeclaration);
    (el as unknown as Record<string, unknown>).value = "initial";
    const onUpdate = vi.fn();

    bind(el, onUpdate);

    expect(onUpdate).toHaveBeenCalledWith("value", "initial");
  });

  it("skips initial sync when the declared property is not exposed on the target", () => {
    const el = createBindableElement(validDeclaration);
    // value is not assigned; "value" is not declared as a prototype property either.
    const onUpdate = vi.fn();

    bind(el, onUpdate);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("delivers an explicitly-undefined initial value (in operator)", () => {
    // The previous "undefined sentinel" rule could not distinguish "value is
    // undefined" from "property not on target". The current rule uses `in`,
    // so an own property holding undefined is delivered.
    const el = createBindableElement(validDeclaration);
    (el as unknown as Record<string, unknown>).value = undefined;
    const onUpdate = vi.fn();

    bind(el, onUpdate);

    expect(onUpdate).toHaveBeenCalledWith("value", undefined);
  });

  it("synchronizes multiple initial values", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "test:value-changed" },
        { name: "checked", event: "test:checked-changed" },
      ],
    });
    (el as unknown as Record<string, unknown>).value = "hello";
    (el as unknown as Record<string, unknown>).checked = true;
    const onUpdate = vi.fn();

    bind(el, onUpdate);

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");
    expect(onUpdate).toHaveBeenCalledWith("checked", true);
  });

  describe("syncOn: connect", () => {
    it("defers initial sync until the element is connected", async () => {
      const el = createBindableElement(validDeclaration);
      (el as unknown as Record<string, unknown>).value = "early";
      const onUpdate = vi.fn();

      bind(el, onUpdate, { syncOn: "connect" });
      expect(onUpdate).not.toHaveBeenCalled();

      // Mutate the value after bind() but before connection — when the
      // element is connected, the deferred initial sync should observe the
      // most recent value rather than the value at bind() time.
      (el as unknown as Record<string, unknown>).value = "late";
      document.body.appendChild(el);

      // MutationObserver delivery is microtask-queued; wait for it.
      await new Promise((r) => setTimeout(r, 0));

      expect(onUpdate).toHaveBeenCalledWith("value", "late");
      document.body.removeChild(el);
    });

    it("syncs immediately when the element is already connected", () => {
      const el = createBindableElement(validDeclaration);
      (el as unknown as Record<string, unknown>).value = "connected";
      document.body.appendChild(el);

      const onUpdate = vi.fn();
      bind(el, onUpdate, { syncOn: "connect" });

      expect(onUpdate).toHaveBeenCalledWith("value", "connected");
      document.body.removeChild(el);
    });

    it("unbind() cancels a pending deferred sync", async () => {
      const el = createBindableElement(validDeclaration);
      (el as unknown as Record<string, unknown>).value = "v";
      const onUpdate = vi.fn();

      const unbind = bind(el, onUpdate, { syncOn: "connect" });
      unbind();
      document.body.appendChild(el);
      await new Promise((r) => setTimeout(r, 0));

      expect(onUpdate).not.toHaveBeenCalled();
      document.body.removeChild(el);
    });

    it("falls back to immediate sync for headless EventTargets", () => {
      class HeadlessCore extends EventTarget {
        static wcBindable: WcBindableDeclaration = {
          protocol: "wc-bindable",
          version: 1,
          properties: [{ name: "value", event: "test:value-changed" }],
        };
        value = "headless";
      }

      const onUpdate = vi.fn();
      bind(new HeadlessCore(), onUpdate, { syncOn: "connect" });

      expect(onUpdate).toHaveBeenCalledWith("value", "headless");
    });
  });
});
