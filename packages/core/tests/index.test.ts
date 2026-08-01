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

  it("returns undefined when an input descriptor's attribute is not a string", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "test:e" }],
      inputs: [{ name: "value", attribute: 123 as unknown as string }],
    });
    expect(getWcBindableDeclaration(el)).toBeUndefined();
  });

  it("returns undefined when a command descriptor's async is not a boolean", () => {
    const el = createBindableElement({
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: "test:e" }],
      commands: [{ name: "fetch", async: "yes" as unknown as boolean }],
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

  it("does NOT install a MutationObserver under syncOn:connect when properties is empty", () => {
    // Regression: a previous draft would install a document-wide observer
    // for an empty-properties / unconnected / syncOn:connect bind, breaking
    // the "empty properties returns a no-op cleanup" promise. The fix
    // short-circuits the deferred path when properties.length === 0.
    class EmptyCore extends HTMLElement {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
        commands: [{ name: "ping" }],
      };
    }
    const tag = `empty-${Math.random().toString(36).slice(2, 8)}`;
    customElements.define(tag, EmptyCore);
    const el = document.createElement(tag);
    // Intentionally NOT connected.
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    try {
      const unbind = bind(el, () => {}, { syncOn: "connect" });
      expect(observeSpy).not.toHaveBeenCalled();
      unbind();
    } finally {
      observeSpy.mockRestore();
    }
  });

  it("cleans up already-registered listeners when a later addEventListener throws (no leak)", () => {
    // Regression for the registration-loop leak: if addEventListener throws
    // on the Nth property (e.g. a Proxy-wrapped relay target whose `get`
    // trap throws), the first N-1 listeners must be torn down before the
    // error reaches the caller. Without the fix, those listeners stayed
    // attached and bind() never returned an unbind function.
    const declarations: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "a", event: "test:a" },
        { name: "b", event: "test:b" },
      ],
    };

    class HostileCore extends EventTarget {
      static wcBindable = declarations;
      _callCount = 0;
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        this._callCount++;
        if (this._callCount === 2) throw new Error("simulated trap throw");
        super.addEventListener(type, listener);
      }
    }

    const core = new HostileCore();
    const realRemove = core.removeEventListener.bind(core);
    const removeSpy = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      realRemove(type, listener);
    });
    core.removeEventListener = removeSpy;

    const onUpdate = vi.fn();
    expect(() => bind(core, onUpdate)).toThrow("simulated trap throw");

    // The first listener (for "a") was registered before the throw, and the
    // cleanup-on-throw wrapper must have removed it before propagating.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith("test:a", expect.any(Function));

    // Dispatching the leaked event should NOT reach onUpdate.
    core.dispatchEvent(new CustomEvent("test:a", { detail: 1 }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("throws synchronously when onUpdate is not a function", () => {
    // Empty-properties target: a deferred error would never fire because
    // there are no events to deliver. SPEC § onUpdate validity SHOULD-throws
    // up front so the bug is visible at bind-time.
    class EmptyCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [],
      };
    }
    expect(() => bind(new EmptyCore(), null as unknown as () => void)).toThrow(TypeError);
    expect(() => bind(new EmptyCore(), 42 as unknown as () => void)).toThrow(TypeError);
    expect(() => bind(new EmptyCore(), "nope" as unknown as () => void)).toThrow(TypeError);
  });

  it("does not leak listeners when MutationObserver.observe() throws during deferred-sync setup", () => {
    // Regression for Issue C: when the deferred-sync observer setup
    // throws (a hostile MutationObserverCtor or observe() that raises),
    // the registration loop's already-installed listeners must be torn
    // down before the error reaches the caller. Previously the canDefer
    // block sat OUTSIDE runOrCleanup, so an observe() throw escaped
    // unprotected and the listeners leaked.
    const el = createBindableElement(validDeclaration);
    const realRemove = el.removeEventListener.bind(el);
    const removeSpy = vi.fn(realRemove);
    el.removeEventListener = removeSpy as typeof el.removeEventListener;

    // Sabotage MutationObserver.observe so the deferred-sync setup
    // throws synchronously.
    const realObserve = MutationObserver.prototype.observe;
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe")
      .mockImplementation(() => { throw new Error("observe trap"); });
    try {
      const onUpdate = vi.fn();
      expect(() => bind(el, onUpdate, { syncOn: "connect" })).toThrow("observe trap");
      // The registration loop already attached one listener for "value".
      // The cleanup-on-throw path must have removed it before the throw
      // propagated, so the spy records exactly one removeEventListener call.
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledWith("test:value-changed", expect.any(Function));

      // Confirm there really is no listener left by dispatching the event.
      el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "leaked?" }));
      expect(onUpdate).not.toHaveBeenCalled();
    } finally {
      observeSpy.mockRestore();
      MutationObserver.prototype.observe = realObserve;
    }
  });

  it("disposes the deferred-sync observer exactly once across both the success callback and unbind", async () => {
    // Regression: the previous shape called observer.disconnect() twice
    // on the success-then-throw path (once manually in the callback's
    // success branch, then again via cleanups iteration). Standard
    // MutationObserver is idempotent so the bug was invisible, but
    // SPEC.md § Teardown Contract names "overridden observer.disconnect()"
    // as in-scope of the hostile-target threat model. The single-path
    // disposeObserver helper guarantees one call total, regardless of
    // path (success-then-unbind, success-then-throw, etc.).
    const el = createBindableElement(validDeclaration);
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    try {
      const unbind = bind(el, () => {}, { syncOn: "connect" });
      document.body.appendChild(el);
      // MutationObserver microtask: callback fires → disposeObserver()
      // → disconnect() #1 → initialSync runs successfully.
      await new Promise((r) => setTimeout(r, 0));
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      // unbind path: cleanups include disposeObserver, which is already
      // disposed → MUST NOT call disconnect() a second time.
      unbind();
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      // Idempotent unbind: calling again still keeps disconnect at 1.
      unbind();
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      document.body.removeChild(el);
    } finally {
      disconnectSpy.mockRestore();
    }
  });

  it("unbind() is unconditionally idempotent — second call does not re-invoke cleanups", () => {
    // Regression for the idempotency MUST in § Teardown Contract: the
    // returned closure SHOULD guard re-entry with a `disposed` flag so a
    // hostile (non-idempotent) removeEventListener / disconnect is not
    // called twice. This test wraps removeEventListener with a spy to
    // detect a second call.
    class TwoEventCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "a", event: "test:a" },
          { name: "b", event: "test:b" },
        ],
      };
    }
    const core = new TwoEventCore();
    const realRemove = core.removeEventListener.bind(core);
    const removeSpy = vi.fn(realRemove);
    core.removeEventListener = removeSpy;

    const unbind = bind(core, () => {});

    unbind();
    expect(removeSpy).toHaveBeenCalledTimes(2); // one per property

    unbind(); // second call MUST be a no-op
    expect(removeSpy).toHaveBeenCalledTimes(2); // still 2, not 4
  });

  it("cleans up all listeners even when an earlier cleanup throws (exception-safe unbind)", () => {
    // Regression: unbind previously aborted on the first throwing cleanup,
    // leaving later listeners attached. Now wraps each cleanup in try/catch.
    class TwoEventCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "a", event: "test:a" },
          { name: "b", event: "test:b" },
        ],
      };
    }
    const core = new TwoEventCore();
    // Sabotage the first removeEventListener call so it throws once.
    const real = core.removeEventListener.bind(core);
    let sabotaged = false;
    core.removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (!sabotaged) {
        sabotaged = true;
        // Still actually remove the listener so the next dispatch test reflects
        // teardown intent. The throw is the contract violation we want to
        // recover from.
        real(type, listener);
        throw new Error("remove threw");
      }
      real(type, listener);
    });

    const onUpdate = vi.fn();
    const unbind = bind(core, onUpdate);
    expect(() => unbind()).not.toThrow();

    // After unbind, neither event should reach onUpdate.
    onUpdate.mockClear();
    core.dispatchEvent(new CustomEvent("test:a", { detail: 1 }));
    core.dispatchEvent(new CustomEvent("test:b", { detail: 2 }));
    expect(onUpdate).not.toHaveBeenCalled();
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

  it("returns undefined when a hostile wcBindable declaration's getter throws on schema fields", () => {
    // SPEC.md § Discovery API MUST NOT throw covers hostile declarations
    // too, not only hostile targets. A Proxy `wcBindable` whose `protocol`
    // or `version` getter raises must funnel to `undefined` rather than
    // crash the discovery helper.
    const hostileDecl = new Proxy({} as Partial<WcBindableDeclaration>, {
      get(_t, prop) {
        if (prop === "protocol" || prop === "version" || prop === "properties") {
          throw new Error(`decl trap rejected ${String(prop)}`);
        }
        return undefined;
      },
    });
    class HostileDeclCore extends EventTarget {
      static get wcBindable(): WcBindableDeclaration { return hostileDecl as WcBindableDeclaration; }
    }
    const target = new HostileDeclCore();
    expect(() => getWcBindableDeclaration(target)).not.toThrow();
    expect(getWcBindableDeclaration(target)).toBeUndefined();
    expect(() => bind(target, () => {})).not.toThrow();
  });

  it("returns undefined when a hostile property descriptor's getter throws on `name`", () => {
    // Same MUST NOT throw coverage, one level deeper: a Proxy descriptor
    // inside `properties` whose `name` getter raises during isValidNamedList
    // iteration must also funnel to `undefined`.
    const hostileDescriptor = new Proxy({}, {
      get(_t, prop) {
        if (prop === "name") throw new Error("descriptor trap rejected name");
        return undefined;
      },
    });
    class HostileDescCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [hostileDescriptor as unknown as { name: string; event: string }],
      };
    }
    const target = new HostileDescCore();
    expect(() => getWcBindableDeclaration(target)).not.toThrow();
    expect(getWcBindableDeclaration(target)).toBeUndefined();
    expect(() => bind(target, () => {})).not.toThrow();
  });

  it("returns undefined (does not throw) when a hostile Proxy throws on capability access", () => {
    // SPEC.md § Discovery API: getWcBindableDeclaration MUST NOT throw on
    // any input shape, including hostile Proxy targets whose `get` trap
    // throws on access to addEventListener / removeEventListener /
    // constructor. The capability check must therefore live inside the
    // try/catch alongside the constructor read.
    const hostile = new Proxy({}, {
      get(_t, prop) {
        if (prop === "addEventListener" || prop === "removeEventListener" || prop === "constructor") {
          throw new Error(`proxy trap rejected access to ${String(prop)}`);
        }
        return undefined;
      },
    });
    expect(() => getWcBindableDeclaration(hostile)).not.toThrow();
    expect(getWcBindableDeclaration(hostile)).toBeUndefined();
    expect(() => isWcBindable(hostile)).not.toThrow();
    expect(isWcBindable(hostile)).toBe(false);
    expect(() => bind(hostile, () => {})).not.toThrow();
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

  it("accepts arbitrary unknown inputs (null, primitives, plain objects) and returns a no-op cleanup", () => {
    // bind() signature is `target: unknown` precisely to absorb the common
    // `document.querySelector(...)` returning null case without a separate
    // null check at the call site.
    for (const probe of [null, undefined, 0, "string", true, Symbol("x"), {}, [], new Map()]) {
      const onUpdate = vi.fn();
      let unbind: (() => void) | undefined;
      expect(() => {
        unbind = bind(probe, onUpdate);
      }).not.toThrow();
      expect(typeof unbind).toBe("function");
      unbind!();
      expect(onUpdate).not.toHaveBeenCalled();
    }
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

  describe("syncOn: define", () => {
    // happy-dom (20.x) does not implement custom element *upgrade*. Two
    // divergences from real browsers matter, both verified against
    // happy-dom 20.8.3:
    //
    //   1. After `customElements.define()`, an instance created or parsed
    //      beforehand keeps `constructor === HTMLElement` forever —
    //      neither insertion nor `customElements.upgrade()` swaps its
    //      prototype.
    //   2. For an element already IN the document, `define()` *replaces
    //      the node*: the original reference is orphaned (`parentElement`
    //      becomes undefined, `querySelector` returns a different object)
    //      while a fresh node takes its place. Real browsers upgrade in
    //      place and preserve node identity.
    //
    // Real browsers do (1) as a prototype swap, and the deferred path
    // depends only on its observable result (`target.constructor.wcBindable`
    // becoming readable), so these tests perform the swap explicitly at the
    // point the platform would: inside `customElements.define()`, before
    // `whenDefined()`'s promise resolves. (2) does not affect these tests —
    // they assert on the reference they hold, which keeps its listeners —
    // but it is why the Alpine adapter cannot carry an equivalent test; see
    // packages/alpine/tests/wcBindable.test.ts for that note.
    //
    // Per CLAUDE.md § Test environment, an explicit in-test workaround is
    // the sanctioned option for a happy-dom gap.
    function defineUpgrading(tag: string, Ctor: CustomElementConstructor, ...instances: HTMLElement[]): void {
      customElements.define(tag, Ctor);
      for (const el of instances) Object.setPrototypeOf(el, Ctor.prototype);
    }

    // Accessors (not class fields) so the declared property survives the
    // prototype swap above — a class field is assigned by the constructor,
    // which the simulated upgrade does not run.
    function lateBindableClass(initial: unknown): CustomElementConstructor {
      let current = initial;
      return class LateElement extends HTMLElement {
        static wcBindable: WcBindableDeclaration = validDeclaration;
        get value(): unknown { return current; }
        set value(v: unknown) { current = v; }
      };
    }

    const uniqueTag = (prefix: string) =>
      `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

    it("behaves exactly like syncOn:call when the declaration is already readable", () => {
      const el = createBindableElement(validDeclaration);
      (el as unknown as Record<string, unknown>).value = "already-defined";
      const onUpdate = vi.fn();

      const unbind = bind(el, onUpdate, { syncOn: "define" });

      // Same synchronous point as "call" — no microtask in between.
      expect(onUpdate).toHaveBeenCalledWith("value", "already-defined");
      unbind();
    });

    it("does not wait on customElements when the declaration is already readable", () => {
      const el = createBindableElement(validDeclaration);
      const whenDefinedSpy = vi.spyOn(customElements, "whenDefined");
      try {
        bind(el, () => {}, { syncOn: "define" })();
        expect(whenDefinedSpy).not.toHaveBeenCalled();
      } finally {
        whenDefinedSpy.mockRestore();
      }
    });

    it("delivers the initial sync and subsequent events after a later define()", async () => {
      const tag = uniqueTag("late");
      const el = document.createElement(tag);
      const onUpdate = vi.fn();

      const unbind = bind(el, onUpdate, { syncOn: "define" });
      expect(onUpdate).not.toHaveBeenCalled();

      defineUpgrading(tag, lateBindableClass("arrived"), el);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      expect(onUpdate).toHaveBeenCalledWith("value", "arrived");

      onUpdate.mockClear();
      el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "next" }));
      expect(onUpdate).toHaveBeenCalledWith("value", "next");

      unbind();
      el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "after-unbind" }));
      expect(onUpdate).not.toHaveBeenCalledWith("value", "after-unbind");
    });

    it("registers nothing when the cleanup runs while the wait is still pending", async () => {
      const tag = uniqueTag("cancelled");
      const el = document.createElement(tag);
      const onUpdate = vi.fn();

      const unbind = bind(el, onUpdate, { syncOn: "define" });
      unbind();

      defineUpgrading(tag, lateBindableClass("never-delivered"), el);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      expect(onUpdate).not.toHaveBeenCalled();

      // No listener was installed either, so a later event stays silent.
      el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "x" }));
      expect(onUpdate).not.toHaveBeenCalled();

      // Idempotent, as always.
      expect(() => unbind()).not.toThrow();
    });

    it("does not wait for a plain dashless element", () => {
      const el = document.createElement("div");
      const onUpdate = vi.fn();
      const whenDefinedSpy = vi.spyOn(customElements, "whenDefined");

      try {
        const unbind = bind(el, onUpdate, { syncOn: "define" });
        expect(whenDefinedSpy).not.toHaveBeenCalled();
        expect(onUpdate).not.toHaveBeenCalled();
        expect(() => unbind()).not.toThrow();
      } finally {
        whenDefinedSpy.mockRestore();
      }
    });

    it("does not wait for a non-element target", () => {
      const whenDefinedSpy = vi.spyOn(customElements, "whenDefined");
      try {
        for (const target of [null, undefined, {}, new EventTarget()]) {
          expect(() => bind(target, () => {}, { syncOn: "define" })()).not.toThrow();
        }
        expect(whenDefinedSpy).not.toHaveBeenCalled();
      } finally {
        whenDefinedSpy.mockRestore();
      }
    });

    it("registers nothing when the tag is defined but not wc-bindable", async () => {
      const tag = uniqueTag("plain");
      const el = document.createElement(tag);
      const onUpdate = vi.fn();

      const unbind = bind(el, onUpdate, { syncOn: "define" });
      defineUpgrading(tag, class extends HTMLElement {}, el);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      expect(onUpdate).not.toHaveBeenCalled();
      el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "x" }));
      expect(onUpdate).not.toHaveBeenCalled();
      expect(() => unbind()).not.toThrow();
    });

    it("honours an unbind() called from onUpdate during the deferred initial sync", async () => {
      // This mode is the first in which the caller holds the unbind
      // function *before* the initial sync runs, so a self-tearing-down
      // onUpdate re-enters the cleanup while the registration is only
      // half-recorded. Without the post-registration disposal re-check,
      // the listeners installed in that same reaction would stay attached.
      const tag = uniqueTag("reentrant");
      const el = document.createElement(tag);
      const seen: unknown[] = [];

      let unbind: (() => void) | undefined;
      unbind = bind(el, (_name, value) => {
        seen.push(value);
        unbind?.();
      }, { syncOn: "define" });

      defineUpgrading(tag, lateBindableClass("first"), el);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      expect(seen).toEqual(["first"]);

      // The listener installed during that reaction must be gone.
      el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "after" }));
      expect(seen).toEqual(["first"]);

      // And the cleanup stays idempotent.
      expect(() => unbind?.()).not.toThrow();
      el.dispatchEvent(new CustomEvent("test:value-changed", { detail: "again" }));
      expect(seen).toEqual(["first"]);
    });

    it("keeps concurrent waits on the same element independent", async () => {
      const tag = uniqueTag("shared");
      const el = document.createElement(tag);
      const first = vi.fn();
      const second = vi.fn();

      const unbindFirst = bind(el, first, { syncOn: "define" });
      bind(el, second, { syncOn: "define" });

      // Cancelling one wait must not disturb the other.
      unbindFirst();

      defineUpgrading(tag, lateBindableClass("shared-value"), el);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith("value", "shared-value");
    });

    it("arms one whenDefined() wait per tag, however many binds join it", async () => {
      // Waits are pooled per tag name so that a cancelled bind can drop out
      // of the pool and stop retaining its target — a reaction-per-bind
      // implementation cannot release anything, because whenDefined()
      // offers no cancellation and a promise reaction pins what it closes
      // over until the promise settles.
      const tag = uniqueTag("pooled");
      const first = document.createElement(tag);
      const second = document.createElement(tag);
      const onFirst = vi.fn();
      const onSecond = vi.fn();
      const whenDefinedSpy = vi.spyOn(customElements, "whenDefined");

      try {
        bind(first, onFirst, { syncOn: "define" });
        bind(second, onSecond, { syncOn: "define" });
        expect(whenDefinedSpy).toHaveBeenCalledTimes(1);
      } finally {
        whenDefinedSpy.mockRestore();
      }

      defineUpgrading(tag, lateBindableClass("pooled-value"), first, second);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      // Pooling is an implementation detail, not a behavioral one: both
      // binds still register and deliver independently.
      expect(onFirst).toHaveBeenCalledWith("value", "pooled-value");
      expect(onSecond).toHaveBeenCalledWith("value", "pooled-value");
    });

    it("re-arms a wait for the same tag after every earlier bind was cancelled", async () => {
      // The pool entry survives its set going empty (so churn against a
      // never-defined tag reuses one reaction instead of accumulating one
      // per bind). A later bind on that tag MUST still work.
      const tag = uniqueTag("rearm");
      const early = document.createElement(tag);
      const late = document.createElement(tag);
      const onEarly = vi.fn();
      const onLate = vi.fn();

      bind(early, onEarly, { syncOn: "define" })();  // bound then immediately cancelled
      bind(late, onLate, { syncOn: "define" });

      defineUpgrading(tag, lateBindableClass("rearmed"), early, late);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      expect(onEarly).not.toHaveBeenCalled();
      expect(onLate).toHaveBeenCalledWith("value", "rearmed");
    });

    it("keeps a sibling bind registering when another bind on the same tag throws", async () => {
      // The waits share one promise reaction, so the loop that runs them
      // must isolate failures: one bind whose initial sync throws MUST NOT
      // stop the next bind on the same tag from registering. The throw is
      // still reported — on its own unhandled rejection, per SPEC.md
      // § Teardown Contract — which this test intercepts at the Node level
      // so it does not surface as a suite-level unhandled error.
      const tag = uniqueTag("throwing");
      const throwing = document.createElement(tag);
      const healthy = document.createElement(tag);
      const onHealthy = vi.fn();
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => { rejections.push(reason); };
      process.on("unhandledRejection", onRejection);

      try {
        const boom = new Error("consumer onUpdate exploded");
        const unbindThrowing = bind(throwing, () => { throw boom; }, { syncOn: "define" });
        bind(healthy, onHealthy, { syncOn: "define" });

        defineUpgrading(tag, lateBindableClass("survives"), throwing, healthy);
        await customElements.whenDefined(tag);
        await new Promise((r) => setTimeout(r, 0));

        // The sibling registered despite the earlier waiter throwing.
        expect(onHealthy).toHaveBeenCalledWith("value", "survives");

        // The failure was reported, not swallowed.
        expect(rejections).toContain(boom);

        // And the failed bind tore its own listeners down, so its unbind()
        // is a literal no-op afterwards.
        expect(() => unbindThrowing()).not.toThrow();
      } finally {
        process.off("unhandledRejection", onRejection);
      }
    });

    it("does not reject for a hyphenated name that can never be a custom element", async () => {
      // `font-face` and friends contain a `-` but are reserved names, so
      // `customElements.whenDefined()` returns a *rejected* promise. The
      // implementation attaches a rejection handler; if it did not, vitest
      // would fail this run with an unhandled rejection.
      const el = document.createElement("font-face");
      const onUpdate = vi.fn();

      expect(() => bind(el, onUpdate, { syncOn: "define" })()).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));

      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("composes with connect: waits for the definition, then for connection", async () => {
      const tag = uniqueTag("composed");
      const el = document.createElement(tag);
      const onUpdate = vi.fn();

      const unbind = bind(el, onUpdate, { syncOn: ["define", "connect"] });

      defineUpgrading(tag, lateBindableClass("at-definition"), el);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      // Defined, but still detached — the initial sync is deferred again.
      expect(onUpdate).not.toHaveBeenCalled();

      // The value moves between definition and connection; the deferred
      // sync must read at connection time, per the "connect" ordering rule.
      (el as unknown as Record<string, unknown>).value = "at-connection";
      document.body.appendChild(el);
      await new Promise((r) => setTimeout(r, 0));

      expect(onUpdate).toHaveBeenCalledWith("value", "at-connection");

      unbind();
      document.body.removeChild(el);
    });

    it("composes in either order, and tolerates inert or unknown array entries", async () => {
      const tag = uniqueTag("orderless");
      const el = document.createElement(tag);
      const onUpdate = vi.fn();

      const unbind = bind(el, onUpdate, {
        syncOn: ["call", "later", "connect", "define"] as unknown as ("call" | "connect" | "define")[],
      });

      defineUpgrading(tag, lateBindableClass("v"), el);
      await customElements.whenDefined(tag);
      await Promise.resolve();
      expect(onUpdate).not.toHaveBeenCalled();  // "connect" still in effect

      document.body.appendChild(el);
      await new Promise((r) => setTimeout(r, 0));
      expect(onUpdate).toHaveBeenCalledWith("value", "v");

      unbind();
      document.body.removeChild(el);
    });

    it("treats a malformed syncOn as the plain default", () => {
      const el = createBindableElement(validDeclaration);
      (el as unknown as Record<string, unknown>).value = "sync";

      for (const syncOn of [[], ["nope"], 42, null, { define: true }, ["define", "define"]]) {
        const onUpdate = vi.fn();
        const unbind = bind(el, onUpdate, { syncOn } as never);
        // The declaration is readable, so every one of these behaves as
        // "call" — including the duplicate-entry array, which is simply
        // "define" and therefore also "call" here.
        expect(onUpdate).toHaveBeenCalledWith("value", "sync");
        unbind();
      }

      // And a hostile array whose reads throw must not escape bind().
      const hostile = new Proxy(["define"], {
        get(t, p, r) {
          if (p === "includes") return () => { throw new Error("hostile includes"); };
          return Reflect.get(t, p, r);
        },
      });
      const onUpdate = vi.fn();
      expect(() => bind(el, onUpdate, { syncOn: hostile as never })()).not.toThrow();
      expect(onUpdate).toHaveBeenCalledWith("value", "sync");
    });

    it("leaves the default modes unchanged for an un-upgraded element", async () => {
      // The regression guard for "no default behavior change": under
      // "call", "connect", and an unrecognized value, an un-upgraded
      // custom element still takes the historical silent no-op path.
      const tag = uniqueTag("default");
      const el = document.createElement(tag);
      const onCall = vi.fn();
      const onConnect = vi.fn();
      const onUnknown = vi.fn();

      bind(el, onCall);
      bind(el, onConnect, { syncOn: "connect" });
      bind(el, onUnknown, { syncOn: "later" as unknown as "call" });

      defineUpgrading(tag, lateBindableClass("ignored"), el);
      await customElements.whenDefined(tag);
      await Promise.resolve();

      expect(onCall).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
      expect(onUnknown).not.toHaveBeenCalled();
    });
  });
});
