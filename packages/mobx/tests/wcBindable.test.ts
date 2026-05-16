import { describe, it, expect, vi } from "vitest";
import { autorun, isObservable, isObservableProp, reaction } from "mobx";
import { wcBindable, createWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "mobx-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "mobx-test-input:value-changed" },
      { name: "checked", event: "mobx-test-input:checked-changed" },
    ],
  };
  class MobxTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, MobxTestInput);
}

describe("wcBindable helper", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: "hello" }),
    );
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");

    unbind();
  });

  it("handles multiple properties", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: "a" }),
    );
    el.dispatchEvent(
      new CustomEvent("mobx-test-input:checked-changed", { detail: true }),
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
      new CustomEvent("mobx-test-input:value-changed", { detail: "ignored" }),
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
  it("exposes an observable state object", () => {
    const binder = createWcBindable<{ value: string }>({ value: "x" });
    expect(isObservable(binder.state)).toBe(true);
    expect(isObservableProp(binder.state, "value")).toBe(true);
  });

  it("updates state on bindable events", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked: boolean }>({
      value: "",
      checked: false,
    });

    binder.bind(el);

    el.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: "hello" }),
    );
    expect(binder.state.value).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("mobx-test-input:checked-changed", { detail: true }),
    );
    expect(binder.state.checked).toBe(true);

    binder.unbind();
  });

  it("retains initialValues until updated", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "initial" });

    expect(binder.state.value).toBe("initial");

    binder.bind(el);
    expect(binder.state.value).toBe("initial");

    binder.unbind();
  });

  it("stops updating state after unbind", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el);
    binder.unbind();

    el.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: "ignored" }),
    );

    expect(binder.state.value).toBe("");
  });

  it("rebinds cleanly when bind is called twice", () => {
    const el1 = document.createElement(TAG);
    const el2 = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el1);
    binder.bind(el2);

    el1.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: "from-1" }),
    );
    expect(binder.state.value).toBe("");

    el2.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: "from-2" }),
    );
    expect(binder.state.value).toBe("from-2");

    binder.unbind();
  });

  it("is a no-op for non-bindable elements", () => {
    const el = document.createElement("div");
    const binder = createWcBindable<{ value: string }>({ value: "" });

    expect(() => binder.bind(el)).not.toThrow();
    el.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(binder.state.value).toBe("");
    expect(() => binder.unbind()).not.toThrow();
  });

  it("adds an observable property lazily for keys not in initialValues", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked?: boolean }>({
      value: "",
    });

    expect(isObservableProp(binder.state, "checked")).toBe(false);

    binder.bind(el);
    el.dispatchEvent(
      new CustomEvent("mobx-test-input:checked-changed", { detail: true }),
    );

    expect(binder.state.checked).toBe(true);
    expect(isObservableProp(binder.state, "checked")).toBe(true);

    binder.unbind();
  });

  it("triggers an autorun when a property changes", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "initial" });
    binder.bind(el);

    const observed: string[] = [];
    const dispose = autorun(() => {
      observed.push(binder.state.value);
    });

    el.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: "next" }),
    );

    expect(observed).toEqual(["initial", "next"]);

    dispose();
    binder.unbind();
  });

  it("preserves reference identity for plain arrays and objects (as-is contract)", () => {
    const el = document.createElement(TAG);
    const items = [1, 2, 3];
    const obj = { foo: "bar" };

    // Existing key path: write via initial + update event
    const binder = createWcBindable<{ value: unknown; checked?: unknown }>({
      value: items,
    });
    // initialValues are not deep-enhanced
    expect(binder.state.value).toBe(items);

    binder.bind(el);
    const items2 = [4, 5, 6];
    el.dispatchEvent(
      new CustomEvent("mobx-test-input:value-changed", { detail: items2 }),
    );
    expect(binder.state.value).toBe(items2);

    // Lazy-added key path: write to a key that wasn't in initialValues
    el.dispatchEvent(
      new CustomEvent("mobx-test-input:checked-changed", { detail: obj }),
    );
    expect(binder.state.checked).toBe(obj);

    binder.unbind();
  });

  it("triggers a reaction for lazily added properties", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ checked?: boolean }>({});
    binder.bind(el);

    const seen: unknown[] = [];
    const dispose = reaction(
      () => binder.state.checked,
      (v) => seen.push(v),
    );

    el.dispatchEvent(
      new CustomEvent("mobx-test-input:checked-changed", { detail: true }),
    );

    expect(seen).toEqual([true]);

    dispose();
    binder.unbind();
  });
});
