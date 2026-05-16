import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const forceUpdate = vi.fn();
vi.mock("@stencil/core", () => ({
  forceUpdate: (...args: unknown[]) => forceUpdate(...args),
}));

import { WcBindableController } from "../src/index.js";

const TAG = "stencil-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "stencil-test-input:value-changed" },
      { name: "checked", event: "stencil-test-input:checked-changed" },
    ],
  };
  class StencilTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, StencilTestInput);
}

describe("WcBindableController", () => {
  beforeEach(() => {
    forceUpdate.mockClear();
  });

  it("exposes the provided initial values before any event", () => {
    const host = {};
    const el = document.createElement(TAG);

    const c = new WcBindableController<{ value: string; checked: boolean }>(
      host,
      el,
      { value: "", checked: false },
    );

    expect(c.values).toEqual({ value: "", checked: false });
  });

  it("updates values and forces a host update on bindable events", () => {
    const host = {};
    const el = document.createElement(TAG);

    const c = new WcBindableController<{ value: string; checked: boolean }>(
      host,
      el,
      { value: "", checked: false },
    );

    c.connect();

    el.dispatchEvent(
      new CustomEvent("stencil-test-input:value-changed", { detail: "hello" }),
    );
    expect(c.values.value).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("stencil-test-input:checked-changed", { detail: true }),
    );
    expect(c.values.checked).toBe(true);

    expect(forceUpdate).toHaveBeenCalledWith(host);
  });

  it("stops listening after disconnect", () => {
    const host = {};
    const el = document.createElement(TAG);

    const c = new WcBindableController<{ value: string }>(host, el, {
      value: "",
    });

    c.connect();
    el.dispatchEvent(
      new CustomEvent("stencil-test-input:value-changed", { detail: "before" }),
    );
    expect(c.values.value).toBe("before");

    c.disconnect();
    forceUpdate.mockClear();

    el.dispatchEvent(
      new CustomEvent("stencil-test-input:value-changed", { detail: "after" }),
    );
    expect(c.values.value).toBe("before");
    expect(forceUpdate).not.toHaveBeenCalled();
  });

  it("rebinds when the target getter returns a different element on update()", () => {
    const host = {};
    const first = document.createElement(TAG);
    const second = document.createElement(TAG);
    let current: HTMLElement = first;

    const c = new WcBindableController<{ value: string }>(
      host,
      () => current,
      { value: "" },
    );

    c.connect();
    first.dispatchEvent(
      new CustomEvent("stencil-test-input:value-changed", {
        detail: "from-first",
      }),
    );
    expect(c.values.value).toBe("from-first");

    current = second;
    c.update();

    second.dispatchEvent(
      new CustomEvent("stencil-test-input:value-changed", {
        detail: "from-second",
      }),
    );
    expect(c.values.value).toBe("from-second");

    first.dispatchEvent(
      new CustomEvent("stencil-test-input:value-changed", {
        detail: "ignored",
      }),
    );
    expect(c.values.value).toBe("from-second");
  });

  it("does not bind when the target is missing or not bindable", () => {
    const host = {};

    const missing = new WcBindableController(host, null);
    missing.connect();
    expect(forceUpdate).not.toHaveBeenCalled();

    const plain = document.createElement("div");
    const c = new WcBindableController(host, plain);
    c.connect();
    plain.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(forceUpdate).not.toHaveBeenCalled();

    c.disconnect();
  });

  it("binds on a later update() when the target becomes wc-bindable in place", () => {
    const host = {};

    class LateClass extends HTMLElement {}
    const lateTag = "stencil-test-late-upgrade";
    if (!customElements.get(lateTag))
      customElements.define(lateTag, LateClass);

    const el = document.createElement(lateTag);

    const c = new WcBindableController<{ value: string }>(host, el, {
      value: "",
    });
    c.connect();

    el.dispatchEvent(
      new CustomEvent("stencil-test-late-upgrade:value-changed", {
        detail: "early",
      }),
    );
    expect(c.values.value).toBe("");
    expect(forceUpdate).not.toHaveBeenCalled();

    (LateClass as unknown as { wcBindable: WcBindableDeclaration }).wcBindable =
      {
        protocol: "wc-bindable",
        version: 1,
        properties: [
          { name: "value", event: "stencil-test-late-upgrade:value-changed" },
        ],
      };

    c.update();

    el.dispatchEvent(
      new CustomEvent("stencil-test-late-upgrade:value-changed", {
        detail: "after",
      }),
    );
    expect(c.values.value).toBe("after");
    expect(forceUpdate).toHaveBeenCalledWith(host);
  });

  it("performs an initial sync from properties already present on the element", () => {
    const host = {};
    const el = document.createElement(TAG) as HTMLElement & { value?: string };
    el.value = "preset";

    const c = new WcBindableController<{ value: string }>(host, el);
    c.connect();

    expect(c.values.value).toBe("preset");
    expect(forceUpdate).toHaveBeenCalledWith(host);
  });
});
