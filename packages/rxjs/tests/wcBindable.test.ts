import { describe, it, expect, vi } from "vitest";
import { BehaviorSubject } from "rxjs";
import { wcBindable, createWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "rxjs-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "rxjs-test-input:value-changed" },
      { name: "checked", event: "rxjs-test-input:checked-changed" },
    ],
  };
  class RxjsTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, RxjsTestInput);
}

describe("wcBindable helper", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:value-changed", { detail: "hello" }),
    );
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");

    unbind();
  });

  it("handles multiple properties", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:value-changed", { detail: "a" }),
    );
    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:checked-changed", { detail: true }),
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
      new CustomEvent("rxjs-test-input:value-changed", { detail: "ignored" }),
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
  it("updates BehaviorSubject on bindable events", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked: boolean }>({
      value: "",
      checked: false,
    });

    binder.bind(el);

    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:value-changed", { detail: "hello" }),
    );
    expect(binder.subjects.value.getValue()).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:checked-changed", { detail: true }),
    );
    expect(binder.subjects.checked.getValue()).toBe(true);

    binder.unbind();
  });

  it("exposes BehaviorSubject instances", () => {
    const binder = createWcBindable<{ value: string }>({ value: "x" });
    expect(binder.subjects.value).toBeInstanceOf(BehaviorSubject);
  });

  it("retains initialValues until updated", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "initial" });

    expect(binder.subjects.value.getValue()).toBe("initial");

    binder.bind(el);
    expect(binder.subjects.value.getValue()).toBe("initial");

    binder.unbind();
  });

  it("stops updating subjects after unbind", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el);
    binder.unbind();

    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:value-changed", { detail: "ignored" }),
    );

    expect(binder.subjects.value.getValue()).toBe("");
  });

  it("rebinds cleanly when bind is called twice", () => {
    const el1 = document.createElement(TAG);
    const el2 = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el1);
    binder.bind(el2);

    el1.dispatchEvent(
      new CustomEvent("rxjs-test-input:value-changed", { detail: "from-1" }),
    );
    expect(binder.subjects.value.getValue()).toBe("");

    el2.dispatchEvent(
      new CustomEvent("rxjs-test-input:value-changed", { detail: "from-2" }),
    );
    expect(binder.subjects.value.getValue()).toBe("from-2");

    binder.unbind();
  });

  it("is a no-op for non-bindable elements", () => {
    const el = document.createElement("div");
    const binder = createWcBindable<{ value: string }>({ value: "" });

    expect(() => binder.bind(el)).not.toThrow();
    el.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(binder.subjects.value.getValue()).toBe("");
    expect(() => binder.unbind()).not.toThrow();
  });

  it("creates a BehaviorSubject lazily for properties not in initialValues", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked?: boolean }>({
      value: "",
    });

    expect(binder.subjects.checked).toBeUndefined();

    binder.bind(el);
    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:checked-changed", { detail: true }),
    );

    expect(binder.subjects.checked).toBeDefined();
    expect(binder.subjects.checked!.getValue()).toBe(true);

    binder.unbind();
  });

  it("emits to subscribers on change", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "initial" });
    binder.bind(el);

    const received: string[] = [];
    const sub = binder.subjects.value.subscribe((v) => received.push(v));

    el.dispatchEvent(
      new CustomEvent("rxjs-test-input:value-changed", { detail: "next" }),
    );

    // BehaviorSubject replays current value to new subscribers, then pushes new ones.
    expect(received).toEqual(["initial", "next"]);

    sub.unsubscribe();
    binder.unbind();
  });
});
