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

describe("late definition", () => {
  /**
   * Define `tag` late and stand in for the custom element upgrade a real
   * browser performs inside `define()`. happy-dom does not implement
   * upgrade at all, so an instance created beforehand keeps
   * `constructor === HTMLElement` forever; the deferred bind depends only
   * on the observable result (`constructor.wcBindable` becoming readable),
   * which the prototype swap reproduces. See
   * packages/core/tests/index.test.ts § syncOn: define.
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

  it("wcBindable() binds an element defined after the call", async () => {
    const tag = "mithril-late-helper";
    const el = document.createElement(tag);
    const onUpdate = vi.fn();

    const unbind = wcBindable(el, onUpdate);
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "early" }));
    expect(onUpdate).not.toHaveBeenCalled();

    defineLate(tag, "at-definition", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    expect(onUpdate).toHaveBeenCalledWith("value", "at-definition");
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    expect(onUpdate).toHaveBeenCalledWith("value", "after");

    unbind();
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "gone" }));
    expect(onUpdate).not.toHaveBeenCalledWith("value", "gone");
  });

  it("wcBindable() honours syncOn: \"call\" as an opt-out", async () => {
    const tag = "mithril-late-optout";
    const el = document.createElement(tag);
    const onUpdate = vi.fn();

    wcBindable(el, onUpdate, { syncOn: "call" });
    defineLate(tag, "ignored", el);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
