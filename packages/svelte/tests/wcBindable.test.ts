import { describe, it, expect, vi } from "vitest";
import { wcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "svelte-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "svelte-test-input:value-changed" },
      { name: "checked", event: "svelte-test-input:checked-changed" },
    ],
  };
  class SvelteTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, SvelteTestInput);
}

describe("wcBindable action", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const action = wcBindable(el, { onUpdate });

    el.dispatchEvent(new CustomEvent("svelte-test-input:value-changed", { detail: "hello" }));
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");

    action?.destroy?.();
  });

  it("handles multiple properties", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const action = wcBindable(el, { onUpdate });

    el.dispatchEvent(new CustomEvent("svelte-test-input:value-changed", { detail: "a" }));
    el.dispatchEvent(new CustomEvent("svelte-test-input:checked-changed", { detail: true }));

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("value", "a");
    expect(onUpdate).toHaveBeenCalledWith("checked", true);

    action?.destroy?.();
  });

  it("stops listening after destroy", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const action = wcBindable(el, { onUpdate });
    action?.destroy?.();

    el.dispatchEvent(new CustomEvent("svelte-test-input:value-changed", { detail: "ignored" }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("rebinds when update is called with new params", () => {
    const el = document.createElement(TAG);
    const onUpdate1 = vi.fn();
    const onUpdate2 = vi.fn();

    const action = wcBindable(el, { onUpdate: onUpdate1 });

    el.dispatchEvent(new CustomEvent("svelte-test-input:value-changed", { detail: "first" }));
    expect(onUpdate1).toHaveBeenCalledWith("value", "first");

    action?.update?.({ onUpdate: onUpdate2 });

    el.dispatchEvent(new CustomEvent("svelte-test-input:value-changed", { detail: "second" }));
    expect(onUpdate2).toHaveBeenCalledWith("value", "second");
    expect(onUpdate1).toHaveBeenCalledTimes(1); // not called again

    action?.destroy?.();
  });

  it("handles non-bindable elements gracefully", () => {
    const el = document.createElement("div");
    const onUpdate = vi.fn();

    const action = wcBindable(el, { onUpdate });
    action?.destroy?.(); // should not throw

    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("late definition", () => {
  /**
   * Define `tag` late and stand in for the custom element upgrade a real
   * browser performs inside `define()`. happy-dom does not implement
   * upgrade at all. See packages/core/tests/index.test.ts § syncOn: define.
   */
  function defineLate(tag: string, current: unknown, ...instances: Element[]) {
    const Cls = class extends HTMLElement {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: `${tag}:value-changed` }],
      };
      get value() { return current; }
    };
    customElements.define(tag, Cls);
    for (const el of instances) Object.setPrototypeOf(el, Cls.prototype);
  }

  it("binds an element defined after the action ran", async () => {
    const tag = "svelte-late-action";
    const el = document.createElement(tag);
    const onUpdate = vi.fn();

    const action = wcBindable(el, { onUpdate });
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "early" }));
    expect(onUpdate).not.toHaveBeenCalled();

    defineLate(tag, "at-definition", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    // `update` was never called — the deferred bind completed on its own.
    expect(onUpdate).toHaveBeenCalledWith("value", "at-definition");
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    expect(onUpdate).toHaveBeenCalledWith("value", "after");

    action?.destroy?.();
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "gone" }));
    expect(onUpdate).not.toHaveBeenCalledWith("value", "gone");
  });

  it("honours syncOn: \"call\" as an opt-out", async () => {
    const tag = "svelte-late-optout";
    const el = document.createElement(tag);
    const onUpdate = vi.fn();

    wcBindable(el, { onUpdate, syncOn: "call" });
    defineLate(tag, "ignored", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("destroy() while the wait is pending registers nothing", async () => {
    const tag = "svelte-late-cancelled";
    const el = document.createElement(tag);
    const onUpdate = vi.fn();

    const action = wcBindable(el, { onUpdate });
    action?.destroy?.();

    defineLate(tag, "never", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
