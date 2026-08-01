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

  it("binds an element defined after the directive ran", async () => {
    const tag = "solid-late-directive";
    const el = document.createElement(tag);
    const onUpdate = vi.fn();
    let dispose!: () => void;

    createRoot((d) => {
      dispose = d;
      wcBindable(el, () => onUpdate);
    });

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "early" }));
    expect(onUpdate).not.toHaveBeenCalled();

    defineLate(tag, "at-definition", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    expect(onUpdate).toHaveBeenCalledWith("value", "at-definition");
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    expect(onUpdate).toHaveBeenCalledWith("value", "after");

    dispose();
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "gone" }));
    expect(onUpdate).not.toHaveBeenCalledWith("value", "gone");
  });

  it("honours syncOn: \"call\" as an opt-out", async () => {
    const tag = "solid-late-optout";
    const el = document.createElement(tag);
    const onUpdate = vi.fn();

    createRoot((dispose) => {
      wcBindable(el, () => onUpdate, { syncOn: "call" });
      dispose;
    });

    defineLate(tag, "ignored", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("createWcBindable() forwards the deferral to its directive", async () => {
    const tag = "solid-late-create";
    const el = document.createElement(tag);
    let values!: () => Record<string, unknown>;

    createRoot((dispose) => {
      const [v, directive] = createWcBindable<{ value: string }>({ value: "" });
      values = v as unknown as () => Record<string, unknown>;
      directive(el);
      dispose;
    });

    defineLate(tag, "at-definition", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    expect(values().value).toBe("at-definition");
  });
});
