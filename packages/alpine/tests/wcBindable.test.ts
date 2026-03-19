import { describe, it, expect, beforeEach } from "vitest";
import Alpine from "alpinejs";
import wcBindablePlugin from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "alpine-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "alpine-test-input:value-changed" },
      { name: "checked", event: "alpine-test-input:checked-changed" },
    ],
  };
  class AlpineTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, AlpineTestInput);
}

Alpine.plugin(wcBindablePlugin);

function waitFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(r));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("x-wc-bindable", () => {
  it("binds property values into x-data", async () => {
    document.body.innerHTML = `
      <div x-data="{ value: '', checked: false }">
        <alpine-test-input x-wc-bindable></alpine-test-input>
        <span x-text="value" data-testid="value"></span>
        <span x-text="checked" data-testid="checked"></span>
      </div>
    `;

    Alpine.initTree(document.body);
    await waitFrame();

    const el = document.querySelector(TAG)!;
    el.dispatchEvent(new CustomEvent("alpine-test-input:value-changed", { detail: "hello" }));
    await waitFrame();

    expect(document.querySelector("[data-testid='value']")!.textContent).toBe("hello");
  });

  it("binds into a named object when expression is provided", async () => {
    document.body.innerHTML = `
      <div x-data="{ bound: {} }">
        <alpine-test-input x-wc-bindable="'bound'"></alpine-test-input>
        <span x-text="JSON.stringify(bound)" data-testid="bound"></span>
      </div>
    `;

    Alpine.initTree(document.body);
    await waitFrame();

    const el = document.querySelector(TAG)!;
    el.dispatchEvent(new CustomEvent("alpine-test-input:value-changed", { detail: "world" }));
    await waitFrame();

    const text = document.querySelector("[data-testid='bound']")!.textContent!;
    const parsed = JSON.parse(text);
    expect(parsed.value).toBe("world");
  });

  it("is a no-op for non-bindable elements", async () => {
    document.body.innerHTML = `
      <div x-data="{ value: 'unchanged' }">
        <div x-wc-bindable></div>
        <span x-text="value" data-testid="value"></span>
      </div>
    `;

    Alpine.initTree(document.body);
    await waitFrame();

    expect(document.querySelector("[data-testid='value']")!.textContent).toBe("unchanged");
  });

  it("cleans up when element is removed", async () => {
    document.body.innerHTML = `
      <div x-data="{ value: '' }">
        <alpine-test-input x-wc-bindable></alpine-test-input>
        <span x-text="value" data-testid="value"></span>
      </div>
    `;

    Alpine.initTree(document.body);
    await waitFrame();

    const el = document.querySelector(TAG)!;
    el.dispatchEvent(new CustomEvent("alpine-test-input:value-changed", { detail: "before" }));
    await waitFrame();
    expect(document.querySelector("[data-testid='value']")!.textContent).toBe("before");

    // Remove with Alpine cleanup
    Alpine.destroyTree(el);
    el.remove();

    // Create a new element to dispatch on (old one should have listener removed)
    const detached = document.createElement(TAG);
    // The original el's listeners should be cleaned up - verify no error
    el.dispatchEvent(new CustomEvent("alpine-test-input:value-changed", { detail: "after" }));
    await waitFrame();

    // Value should remain "before" since listener was cleaned up
    expect(document.querySelector("[data-testid='value']")!.textContent).toBe("before");
  });
});
