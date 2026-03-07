import { describe, it, expect, vi } from "vitest";
import { bind, isWcBindable } from "../src/index.js";
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

  it("returns false when version does not match", () => {
    const el = createBindableElement({
      ...validDeclaration,
      version: 2 as 1,
    });
    expect(isWcBindable(el)).toBe(false);
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
});
