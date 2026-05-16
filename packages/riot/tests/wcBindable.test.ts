import { describe, it, expect, vi } from "vitest";
import { wcBindable, createWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "riot-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "riot-test-input:value-changed" },
      { name: "checked", event: "riot-test-input:checked-changed" },
    ],
  };
  class RiotTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, RiotTestInput);
}

describe("wcBindable helper", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("riot-test-input:value-changed", { detail: "hello" }),
    );
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");

    unbind();
  });

  it("handles multiple properties", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("riot-test-input:value-changed", { detail: "a" }),
    );
    el.dispatchEvent(
      new CustomEvent("riot-test-input:checked-changed", { detail: true }),
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
      new CustomEvent("riot-test-input:value-changed", { detail: "ignored" }),
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
  it("updates values and triggers update on bindable events", () => {
    const el = document.createElement(TAG);
    const update = vi.fn();
    const binder = createWcBindable<{ value: string; checked: boolean }>(
      { value: "", checked: false },
      { update },
    );

    binder.bind(el);

    el.dispatchEvent(
      new CustomEvent("riot-test-input:value-changed", { detail: "hello" }),
    );
    expect(binder.values.value).toBe("hello");
    expect(update).toHaveBeenCalledTimes(1);

    el.dispatchEvent(
      new CustomEvent("riot-test-input:checked-changed", { detail: true }),
    );
    expect(binder.values.checked).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);

    binder.unbind();
  });

  it("retains initialValues until updated", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>(
      { value: "initial" },
      { update: () => {} },
    );

    expect(binder.values.value).toBe("initial");

    binder.bind(el);
    expect(binder.values.value).toBe("initial");

    binder.unbind();
  });

  it("stops listening after unbind", () => {
    const el = document.createElement(TAG);
    const update = vi.fn();
    const binder = createWcBindable<{ value: string }>(
      { value: "" },
      { update },
    );

    binder.bind(el);
    binder.unbind();

    update.mockClear();
    el.dispatchEvent(
      new CustomEvent("riot-test-input:value-changed", { detail: "ignored" }),
    );

    expect(binder.values.value).toBe("");
    expect(update).not.toHaveBeenCalled();
  });

  it("rebinds cleanly when bind is called twice", () => {
    const el1 = document.createElement(TAG);
    const el2 = document.createElement(TAG);
    const update = vi.fn();
    const binder = createWcBindable<{ value: string }>(
      { value: "" },
      { update },
    );

    binder.bind(el1);
    binder.bind(el2);

    el1.dispatchEvent(
      new CustomEvent("riot-test-input:value-changed", { detail: "from-1" }),
    );
    expect(binder.values.value).toBe("");

    el2.dispatchEvent(
      new CustomEvent("riot-test-input:value-changed", { detail: "from-2" }),
    );
    expect(binder.values.value).toBe("from-2");

    binder.unbind();
  });

  it("is a no-op for non-bindable elements", () => {
    const el = document.createElement("div");
    const update = vi.fn();
    const binder = createWcBindable<{ value: string }>(
      { value: "" },
      { update },
    );

    expect(() => binder.bind(el)).not.toThrow();
    el.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(update).not.toHaveBeenCalled();
    expect(() => binder.unbind()).not.toThrow();
  });
});
