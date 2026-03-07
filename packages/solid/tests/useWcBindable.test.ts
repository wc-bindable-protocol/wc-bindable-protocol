import { describe, it, expect } from "vitest";
import { createRoot } from "solid-js";
import { useWcBindable } from "../src/index.js";
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

describe("useWcBindable (Solid)", () => {
  it("returns initial values before any event", () => {
    createRoot((dispose) => {
      const el = document.createElement(TAG);
      const values = useWcBindable(el, { value: "", checked: false });

      expect(values().value).toBe("");
      expect(values().checked).toBe(false);

      dispose();
    });
  });

  it("updates values when a bindable event is dispatched", () => {
    createRoot((dispose) => {
      const el = document.createElement(TAG);
      const values = useWcBindable(el, { value: "" });

      el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "hello" }));
      expect(values().value).toBe("hello");

      el.dispatchEvent(new CustomEvent("solid-test-input:checked-changed", { detail: true }));
      expect(values().checked).toBe(true);

      dispose();
    });
  });

  it("stops listening after dispose", () => {
    let el: HTMLElement;
    let values: () => Record<string, unknown>;

    createRoot((dispose) => {
      el = document.createElement(TAG);
      values = useWcBindable(el, { value: "" });

      el.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "before" }));
      expect(values().value).toBe("before");

      dispose();
    });

    el!.dispatchEvent(new CustomEvent("solid-test-input:value-changed", { detail: "after" }));
    expect(values!().value).toBe("before");
  });

  it("handles non-bindable elements gracefully", () => {
    createRoot((dispose) => {
      const el = document.createElement("div");
      const values = useWcBindable(el);

      expect(Object.keys(values())).toHaveLength(0);

      dispose();
    });
  });
});
