import { describe, it, expect, vi } from "vitest";
import { wcBindable, createWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "vanjs-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "vanjs-test-input:value-changed" },
      { name: "checked", event: "vanjs-test-input:checked-changed" },
    ],
  };
  class VanJSTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, VanJSTestInput);
}

describe("wcBindable helper", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:value-changed", { detail: "hello" }),
    );
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");

    unbind();
  });

  it("handles multiple properties", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:value-changed", { detail: "a" }),
    );
    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:checked-changed", { detail: true }),
    );

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("value", "a");
    expect(onUpdate).toHaveBeenCalledWith("checked", true);

    unbind();
  });

  it("performs initial sync for already-set properties", () => {
    const el = document.createElement(TAG) as HTMLElement & { value: string };
    el.value = "preset";
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    expect(onUpdate).toHaveBeenCalledWith("value", "preset");
    unbind();
  });

  it("stops listening after unbind", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);
    unbind();

    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:value-changed", { detail: "ignored" }),
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("returns a no-op unbind for non-bindable elements", () => {
    const el = document.createElement("div");
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);
    expect(typeof unbind).toBe("function");
    expect(() => unbind()).not.toThrow();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("createWcBindable", () => {
  it("updates state .val on bindable events", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked: boolean }>({
      value: "",
      checked: false,
    });

    binder.bind(el);

    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:value-changed", { detail: "hello" }),
    );
    expect(binder.states.value.val).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:checked-changed", { detail: true }),
    );
    expect(binder.states.checked.val).toBe(true);

    binder.unbind();
  });

  it("retains initialValues until updated", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "initial" });

    expect(binder.states.value.val).toBe("initial");

    binder.bind(el);
    expect(binder.states.value.val).toBe("initial");

    binder.unbind();
  });

  it("stops updating state after unbind", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el);
    binder.unbind();

    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:value-changed", { detail: "ignored" }),
    );

    expect(binder.states.value.val).toBe("");
  });

  it("rebinds cleanly when bind is called twice", () => {
    const el1 = document.createElement(TAG);
    const el2 = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el1);
    binder.bind(el2);

    el1.dispatchEvent(
      new CustomEvent("vanjs-test-input:value-changed", { detail: "from-1" }),
    );
    expect(binder.states.value.val).toBe("");

    el2.dispatchEvent(
      new CustomEvent("vanjs-test-input:value-changed", { detail: "from-2" }),
    );
    expect(binder.states.value.val).toBe("from-2");

    binder.unbind();
  });

  it("is a no-op for non-bindable elements", () => {
    const el = document.createElement("div");
    const binder = createWcBindable<{ value: string }>({ value: "" });

    expect(() => binder.bind(el)).not.toThrow();
    el.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(binder.states.value.val).toBe("");
    expect(() => binder.unbind()).not.toThrow();
  });

  it("creates a state lazily for properties not in initialValues", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked?: boolean }>({
      value: "",
    });

    expect(binder.states.checked).toBeUndefined();

    binder.bind(el);
    el.dispatchEvent(
      new CustomEvent("vanjs-test-input:checked-changed", { detail: true }),
    );

    expect(binder.states.checked).toBeDefined();
    expect(binder.states.checked!.val).toBe(true);

    binder.unbind();
  });
});
