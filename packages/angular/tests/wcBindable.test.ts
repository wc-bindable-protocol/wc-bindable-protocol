import { describe, it, expect, vi } from "vitest";
import { WcBindableDirective } from "../src/index.js";
import { ElementRef } from "@angular/core";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "ng-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "ng-test-input:value-changed" },
      { name: "checked", event: "ng-test-input:checked-changed" },
    ],
  };
  class NgTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, NgTestInput);
}

function createDirective(tag: string) {
  const el = document.createElement(tag);
  const ref = new ElementRef(el);
  const directive = new WcBindableDirective(ref);
  return { el, directive };
}

describe("WcBindableDirective", () => {
  it("emits wcBindableChange on ngOnInit when event is dispatched", () => {
    const { el, directive } = createDirective(TAG);
    const spy = vi.fn();

    directive.wcBindableChange.subscribe(spy);
    directive.ngOnInit();

    el.dispatchEvent(new CustomEvent("ng-test-input:value-changed", { detail: "hello" }));

    expect(spy).toHaveBeenCalledWith({ name: "value", value: "hello" });
  });

  it("handles multiple properties", () => {
    const { el, directive } = createDirective(TAG);
    const spy = vi.fn();

    directive.wcBindableChange.subscribe(spy);
    directive.ngOnInit();

    el.dispatchEvent(new CustomEvent("ng-test-input:value-changed", { detail: "a" }));
    el.dispatchEvent(new CustomEvent("ng-test-input:checked-changed", { detail: true }));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ name: "value", value: "a" });
    expect(spy).toHaveBeenCalledWith({ name: "checked", value: true });
  });

  it("stops listening after ngOnDestroy", () => {
    const { el, directive } = createDirective(TAG);
    const spy = vi.fn();

    directive.wcBindableChange.subscribe(spy);
    directive.ngOnInit();
    directive.ngOnDestroy();

    el.dispatchEvent(new CustomEvent("ng-test-input:value-changed", { detail: "ignored" }));

    expect(spy).not.toHaveBeenCalled();
  });

  it("is a no-op for non-bindable elements", () => {
    const { directive } = createDirective("div");
    const spy = vi.fn();

    directive.wcBindableChange.subscribe(spy);
    directive.ngOnInit();
    directive.ngOnDestroy(); // should not throw

    expect(spy).not.toHaveBeenCalled();
  });

  it("synchronizes initial property values on ngOnInit", () => {
    const { el, directive } = createDirective(TAG);
    (el as unknown as Record<string, unknown>).value = "initial";
    const spy = vi.fn();

    directive.wcBindableChange.subscribe(spy);
    directive.ngOnInit();

    expect(spy).toHaveBeenCalledWith({ name: "value", value: "initial" });
  });
});
