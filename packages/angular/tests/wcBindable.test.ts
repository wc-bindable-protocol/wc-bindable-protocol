import { describe, it, expect, vi } from "vitest";
import { bind, isWcBindable } from "@wc-bindable/core";
import type { WcBindableDeclaration } from "@wc-bindable/core";

// The Angular directive delegates to bind() from core.
// Since TestBed requires a full Angular environment, we test the
// directive's logic pattern directly: bind on init, unbind on destroy.

const TAG = "ng-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "ng-test-input:value-changed" },
    ],
  };
  class NgTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, NgTestInput);
}

describe("WcBindableDirective logic", () => {
  it("binds and receives updates via bind()", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    expect(isWcBindable(el)).toBe(true);
    const unbind = bind(el, onUpdate);

    el.dispatchEvent(new CustomEvent("ng-test-input:value-changed", { detail: "angular" }));
    expect(onUpdate).toHaveBeenCalledWith("value", "angular");

    unbind();
  });

  it("stops listening after unbind (simulates ngOnDestroy)", () => {
    const el = document.createElement(TAG);
    const onUpdate = vi.fn();

    const unbind = bind(el, onUpdate);
    unbind();

    el.dispatchEvent(new CustomEvent("ng-test-input:value-changed", { detail: "ignored" }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("skips non-bindable elements (simulates ngOnInit guard)", () => {
    const el = document.createElement("div");
    const onUpdate = vi.fn();

    expect(isWcBindable(el)).toBe(false);
    const unbind = bind(el, onUpdate);
    unbind(); // should be a no-op

    expect(onUpdate).not.toHaveBeenCalled();
  });
});
