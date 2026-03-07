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
});
