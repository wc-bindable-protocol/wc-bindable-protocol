// @vitest-environment node
//
// This file pins the runtime contract that the protocol works in a
// genuinely headless environment — i.e. one where `HTMLElement`,
// `document`, and `MutationObserver` are not defined as globals. Using
// `happy-dom` (the default vitest environment for this repo) would defeat
// the test because those globals would be present.
//
// The module under test captures the DOM-global references at load time
// via `typeof X !== "undefined"`, so this test MUST live in a file with
// the Node environment directive above — stubbing globals after import
// would not re-evaluate the capture.

import { describe, it, expect, vi } from "vitest";
import { bind, isWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "../src/index.js";

describe("headless runtime (no HTMLElement / document / MutationObserver)", () => {
  it("confirms the test environment really has no DOM globals", () => {
    // Guard the guard: if this assertion ever fails, the @vitest-environment
    // directive at the top of the file is no longer in effect and every
    // other test below silently degrades to a happy-dom run.
    expect(typeof HTMLElement).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(typeof MutationObserver).toBe("undefined");
  });

  it("bind() works on an EventTarget-based Core without DOM globals", () => {
    class HeadlessCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: "core:value-changed" }],
      };
      value: string | undefined;
    }
    const core = new HeadlessCore();
    core.value = "initial";

    expect(isWcBindable(core)).toBe(true);

    const onUpdate = vi.fn();
    const unbind = bind(core, onUpdate);

    // Initial sync delivers the pre-bind value.
    expect(onUpdate).toHaveBeenCalledWith("value", "initial");

    // Subsequent events propagate.
    core.dispatchEvent(new CustomEvent("core:value-changed", { detail: "updated" }));
    expect(onUpdate).toHaveBeenCalledWith("value", "updated");

    unbind();
  });

  it("syncOn: \"connect\" silently falls back to immediate sync when DOM globals are missing", () => {
    // The intent of the criticism: instanceof HTMLElement / new MutationObserver
    // would throw ReferenceError in a headless runtime if the implementation
    // did not guard the DOM globals. This test would crash with such a
    // regression — passing means the guards are present and working.
    class HeadlessCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: "core:value-changed" }],
      };
      value = "headless";
    }
    const core = new HeadlessCore();
    const onUpdate = vi.fn();

    expect(() => bind(core, onUpdate, { syncOn: "connect" })).not.toThrow();
    expect(onUpdate).toHaveBeenCalledWith("value", "headless");
  });

  it("syncOn: \"define\" silently falls back when customElements is missing", () => {
    // Same shape as the "connect" fallback above, for the other DOM global
    // the deferred paths touch. A headless runtime has no custom element
    // registry at all, so the "is this an un-upgraded custom element?"
    // question can never be answered — bind() must take the synchronous
    // path rather than throwing a ReferenceError on `customElements`.
    expect(typeof customElements).toBe("undefined");

    class HeadlessCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: "core:value-changed" }],
      };
      value = "headless";
    }
    const onUpdate = vi.fn();

    expect(() => bind(new HeadlessCore(), onUpdate, { syncOn: "define" })).not.toThrow();
    expect(onUpdate).toHaveBeenCalledWith("value", "headless");

    // A non-bindable target still returns the no-op cleanup, without
    // touching the absent registry.
    const noop = bind({}, onUpdate, { syncOn: "define" });
    expect(() => noop()).not.toThrow();
  });

  it("returns a working unbind() that removes listeners in headless mode", () => {
    class HeadlessCore extends EventTarget {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: "core:value-changed" }],
      };
    }
    const core = new HeadlessCore();
    const onUpdate = vi.fn();
    const unbind = bind(core, onUpdate);

    unbind();
    core.dispatchEvent(new CustomEvent("core:value-changed", { detail: "after-unbind" }));

    expect(onUpdate).not.toHaveBeenCalled();
  });
});
