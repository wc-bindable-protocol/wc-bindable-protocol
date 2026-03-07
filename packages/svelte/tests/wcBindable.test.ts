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
