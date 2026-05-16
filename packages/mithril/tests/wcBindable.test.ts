import { describe, it, expect, vi } from "vitest";
import { wcBindable, createWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "mithril-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "mithril-test-input:value-changed" },
      { name: "checked", event: "mithril-test-input:checked-changed" },
    ],
  };
  class MithrilTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, MithrilTestInput);
}

describe("wcBindable helper", () => {
  it("calls onUpdate when a bindable event is dispatched", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("mithril-test-input:value-changed", { detail: "hello" }),
    );
    expect(onUpdate).toHaveBeenCalledWith("value", "hello");

    unbind();
  });

  it("handles multiple properties", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);

    el.dispatchEvent(
      new CustomEvent("mithril-test-input:value-changed", { detail: "a" }),
    );
    el.dispatchEvent(
      new CustomEvent("mithril-test-input:checked-changed", { detail: true }),
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
      new CustomEvent("mithril-test-input:value-changed", { detail: "ignored" }),
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
  it("updates values and triggers redraw on bindable events", () => {
    const el = document.createElement(TAG);
    const redraw = vi.fn();
    const binder = createWcBindable<{ value: string; checked: boolean }>(
      { value: "", checked: false },
      { redraw },
    );

    binder.oncreate({ dom: el });

    el.dispatchEvent(
      new CustomEvent("mithril-test-input:value-changed", { detail: "hello" }),
    );
    expect(binder.values.value).toBe("hello");
    expect(redraw).toHaveBeenCalledTimes(1);

    el.dispatchEvent(
      new CustomEvent("mithril-test-input:checked-changed", { detail: true }),
    );
    expect(binder.values.checked).toBe(true);
    expect(redraw).toHaveBeenCalledTimes(2);

    binder.onremove();
  });

  it("retains initialValues until updated", () => {
    const el = document.createElement(TAG);
    const binder = createWcBindable<{ value: string }>(
      { value: "initial" },
      { redraw: () => {} },
    );

    expect(binder.values.value).toBe("initial");

    binder.oncreate({ dom: el });
    expect(binder.values.value).toBe("initial");

    binder.onremove();
  });

  it("stops listening after onremove", () => {
    const el = document.createElement(TAG);
    const redraw = vi.fn();
    const binder = createWcBindable<{ value: string }>(
      { value: "" },
      { redraw },
    );

    binder.oncreate({ dom: el });
    binder.onremove();

    redraw.mockClear();
    el.dispatchEvent(
      new CustomEvent("mithril-test-input:value-changed", { detail: "ignored" }),
    );

    expect(binder.values.value).toBe("");
    expect(redraw).not.toHaveBeenCalled();
  });

  it("is a no-op for non-bindable elements", () => {
    const el = document.createElement("div");
    const redraw = vi.fn();
    const binder = createWcBindable<{ value: string }>(
      { value: "" },
      { redraw },
    );

    expect(() => binder.oncreate({ dom: el })).not.toThrow();
    el.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(redraw).not.toHaveBeenCalled();
    expect(() => binder.onremove()).not.toThrow();
  });
});
