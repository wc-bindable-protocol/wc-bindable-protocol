import { describe, it, expect } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";
import { useWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

function defineBindableElement(
  tag: string,
  decl: WcBindableDeclaration,
) {
  if (!customElements.get(tag)) {
    const Cls = class extends HTMLElement {
      static wcBindable = decl;
    };
    customElements.define(tag, Cls);
  }
}

/**
 * Define `tag` late and stand in for the custom element upgrade a real
 * browser performs inside `define()` — happy-dom does not implement
 * upgrade at all, so an instance created before the definition keeps
 * `constructor === HTMLElement` forever. The deferred bind depends only on
 * the observable result of the upgrade (`constructor.wcBindable` becoming
 * readable), which the prototype swap reproduces. See
 * packages/core/tests/index.test.ts § syncOn: define.
 */
function defineLate(tag: string, ...instances: Element[]) {
  const Cls = class extends HTMLElement {
    static wcBindable: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "value", event: `${tag}:value-changed` }],
    };
  };
  customElements.define(tag, Cls);
  for (const el of instances) Object.setPrototypeOf(el, Cls.prototype);
}

const TAG = "test-input";
defineBindableElement(TAG, {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "value", event: "test-input:value-changed" },
    { name: "checked", event: "test-input:checked-changed" },
  ],
});

function TestComponent({ onRender }: { onRender: (values: Record<string, unknown>) => void }) {
  const [ref, values] = useWcBindable<HTMLElement>({ value: "", checked: false });
  onRender(values);
  return React.createElement(TAG, { ref });
}

describe("useWcBindable", () => {
  it("returns initial values before any event", () => {
    let captured: Record<string, unknown> = {};
    render(React.createElement(TestComponent, {
      onRender: (v) => { captured = v; },
    }));

    expect(captured.value).toBe("");
    expect(captured.checked).toBe(false);
  });

  it("updates values when a bindable event is dispatched", async () => {
    let captured: Record<string, unknown> = {};
    const { container } = render(React.createElement(TestComponent, {
      onRender: (v) => { captured = v; },
    }));

    const el = container.querySelector(TAG)!;

    await act(() => {
      el.dispatchEvent(new CustomEvent("test-input:value-changed", { detail: "hello" }));
    });
    expect(captured.value).toBe("hello");

    await act(() => {
      el.dispatchEvent(new CustomEvent("test-input:checked-changed", { detail: true }));
    });
    expect(captured.checked).toBe(true);
  });

  it("stops listening after unmount", async () => {
    let captured: Record<string, unknown> = {};
    const { container, unmount } = render(React.createElement(TestComponent, {
      onRender: (v) => { captured = v; },
    }));

    const el = container.querySelector(TAG)!;

    await act(() => {
      el.dispatchEvent(new CustomEvent("test-input:value-changed", { detail: "before" }));
    });
    expect(captured.value).toBe("before");

    unmount();

    // The element still exists in memory, but the listener should be removed.
    // We dispatch again and verify the captured value did not change.
    el.dispatchEvent(new CustomEvent("test-input:value-changed", { detail: "after" }));
    expect(captured.value).toBe("before");
  });

  it("handles non-bindable elements gracefully", () => {
    function NonBindable() {
      const [ref, values] = useWcBindable<HTMLDivElement>();
      return React.createElement("div", { ref, "data-testid": "plain" },
        JSON.stringify(values),
      );
    }

    const { getByTestId } = render(React.createElement(NonBindable));
    expect(getByTestId("plain").textContent).toBe("{}");
  });

  it("binds an element whose definition arrives after mount", async () => {
    const lateTag = "test-late-react";
    let captured: Record<string, unknown> = {};

    function Late() {
      const [ref, values] = useWcBindable<HTMLElement>({ value: "" });
      captured = values;
      return React.createElement(lateTag, { ref });
    }

    const { container } = render(React.createElement(Late));
    const el = container.querySelector(lateTag)!;

    // Not defined yet: the effect has run and bound nothing observable.
    el.dispatchEvent(new CustomEvent("test-late-react:value-changed", { detail: "early" }));
    expect(captured.value).toBe("");

    await act(async () => {
      defineLate(lateTag, el);
      await customElements.whenDefined(lateTag);
    });

    // No re-render, no ref change — the deferred bind completed on its own.
    await act(() => {
      el.dispatchEvent(new CustomEvent("test-late-react:value-changed", { detail: "after" }));
    });
    expect(captured.value).toBe("after");
  });

  it("syncOn: \"call\" opts back into skipping a not-yet-upgraded element", async () => {
    const lateTag = "test-late-react-optout";
    let captured: Record<string, unknown> = {};

    function Late() {
      const [ref, values] = useWcBindable<HTMLElement>({ value: "" }, { syncOn: "call" });
      captured = values;
      return React.createElement(lateTag, { ref });
    }

    const { container } = render(React.createElement(Late));
    const el = container.querySelector(lateTag)!;

    await act(async () => {
      defineLate(lateTag, el);
      await customElements.whenDefined(lateTag);
    });

    await act(() => {
      el.dispatchEvent(new CustomEvent(`${lateTag}:value-changed`, { detail: "after" }));
    });
    expect(captured.value).toBe("");
  });
});
