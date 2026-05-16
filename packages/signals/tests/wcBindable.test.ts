import { describe, it, expect, vi } from "vitest";
import { Signal } from "signal-polyfill";
import { wcBindable, createWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "signals-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "signals-test-input:value-changed" },
      { name: "checked", event: "signals-test-input:checked-changed" },
    ],
  };
  class SignalsTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, SignalsTestInput);
}

describe("wcBindable helper", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("signals-test-input:value-changed", { detail: "hello" }),
    );
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");

    unbind();
  });

  it("handles multiple properties", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("signals-test-input:value-changed", { detail: "a" }),
    );
    el.dispatchEvent(
      new CustomEvent("signals-test-input:checked-changed", { detail: true }),
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
      new CustomEvent("signals-test-input:value-changed", { detail: "ignored" }),
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
  it("updates Signal.State on bindable events", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked: boolean }>({
      value: "",
      checked: false,
    });

    binder.bind(el);

    el.dispatchEvent(
      new CustomEvent("signals-test-input:value-changed", { detail: "hello" }),
    );
    expect(binder.signals.value.get()).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("signals-test-input:checked-changed", { detail: true }),
    );
    expect(binder.signals.checked.get()).toBe(true);

    binder.unbind();
  });

  it("exposes Signal.State instances", () => {
    const binder = createWcBindable<{ value: string }>({ value: "x" });
    expect(binder.signals.value).toBeInstanceOf(Signal.State);
  });

  it("retains initialValues until updated", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "initial" });

    expect(binder.signals.value.get()).toBe("initial");

    binder.bind(el);
    expect(binder.signals.value.get()).toBe("initial");

    binder.unbind();
  });

  it("stops updating state after unbind", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el);
    binder.unbind();

    el.dispatchEvent(
      new CustomEvent("signals-test-input:value-changed", { detail: "ignored" }),
    );

    expect(binder.signals.value.get()).toBe("");
  });

  it("rebinds cleanly when bind is called twice", () => {
    const el1 = document.createElement(TAG);
    const el2 = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "" });

    binder.bind(el1);
    binder.bind(el2);

    el1.dispatchEvent(
      new CustomEvent("signals-test-input:value-changed", { detail: "from-1" }),
    );
    expect(binder.signals.value.get()).toBe("");

    el2.dispatchEvent(
      new CustomEvent("signals-test-input:value-changed", { detail: "from-2" }),
    );
    expect(binder.signals.value.get()).toBe("from-2");

    binder.unbind();
  });

  it("is a no-op for non-bindable elements", () => {
    const el = document.createElement("div");
    const binder = createWcBindable<{ value: string }>({ value: "" });

    expect(() => binder.bind(el)).not.toThrow();
    el.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(binder.signals.value.get()).toBe("");
    expect(() => binder.unbind()).not.toThrow();
  });

  it("creates a Signal.State lazily for properties not in initialValues", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string; checked?: boolean }>({
      value: "",
    });

    expect(binder.signals.checked).toBeUndefined();

    binder.bind(el);
    el.dispatchEvent(
      new CustomEvent("signals-test-input:checked-changed", { detail: true }),
    );

    expect(binder.signals.checked).toBeDefined();
    expect(binder.signals.checked!.get()).toBe(true);

    binder.unbind();
  });

  it("notifies a Signal.subtle.Watcher when a signal changes", async () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>({ value: "initial" });
    binder.bind(el);

    const notify = vi.fn();
    const watcher = new Signal.subtle.Watcher(notify);

    // Wrap the State in a Computed — Watcher only tracks Computed signals.
    const derived = new Signal.Computed(() => binder.signals.value.get());
    watcher.watch(derived);
    derived.get();

    el.dispatchEvent(
      new CustomEvent("signals-test-input:value-changed", { detail: "next" }),
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(derived.get()).toBe("next");

    watcher.unwatch(derived);
    binder.unbind();
  });
});
