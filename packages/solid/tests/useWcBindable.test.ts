import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import { wcBindable, createWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "solid-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "solid-test-input:value-changed" },
      { name: "checked", event: "solid-test-input:checked-changed" },
    ],
  };
  class SolidTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, SolidTestInput);
}

describe("wcBindable directive", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    createRoot((dispose) => {
      const el = document.createElement(TAG);
      const onUpdate = vi.fn();

      wcBindable(el, () => onUpdate);

      el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "hello" }));
      expect(onUpdate).toHaveBeenCalledWith("value", "hello");

      dispose();
    });
  });

  it("stops listening after dispose", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    createRoot((dispose) => {
      wcBindable(el, () => onUpdate);

      el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "before" }));
      expect(onUpdate).toHaveBeenCalledWith("value", "before");

      dispose();
    });

    onUpdate.mockClear();
    el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "after" }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("handles non-bindable elements gracefully", () => {
    createRoot((dispose) => {
      const el = document.createElement("div");
      const onUpdate = vi.fn();

      wcBindable(el, () => onUpdate);

      expect(onUpdate).not.toHaveBeenCalled();

      dispose();
    });
  });
});

describe("createWcBindable", () => {
  it("returns a signal and directive that track property values", () => {
    createRoot((dispose) => {
      const el = document.createElement(TAG);
      const [values, directive] = createWcBindable();

      directive(el);

      el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "hello" }));
      expect(values().value).toBe("hello");

      el.dispatchEvent(new CustomEvent("solid-test-input:checked-changed", { detail: true }));
      expect(values().checked).toBe(true);

      dispose();
    });
  });

  it("stops listening after dispose", () => {
    const el = document.createElement(TAG);
    let values: () => Record<string, unknown>;

    createRoot((dispose) => {
      const [v, directive] = createWcBindable();
      values = v;
      directive(el);

      el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "before" }));
      expect(values().value).toBe("before");

      dispose();
    });

    el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "after" }));
    expect(values!().value).toBe("before");
  });
});
