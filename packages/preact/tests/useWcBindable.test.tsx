import { describe, it, expect } from "vitest";
import { render, act } from "@testing-library/preact";
import { h } from "preact";
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

const TAG = "test-preact-input";
defineBindableElement(TAG, {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "value", event: "test-preact-input:value-changed" },
    { name: "checked", event: "test-preact-input:checked-changed" },
  ],
});

function TestComponent({ onRender }: { onRender: (values: Record<string, unknown>) => void }) {
  const [ref, values] = useWcBindable<HTMLElement>({ value: "", checked: false });
  onRender(values);
  return h(TAG, { ref } as Record<string, unknown>);
}

describe("useWcBindable (Preact)", () => {
  it("returns initial values before any event", () => {
    let captured: Record<string, unknown> = {};
    render(h(TestComponent, {
      onRender: (v) => { captured = v; },
    }));

    expect(captured.value).toBe("");
    expect(captured.checked).toBe(false);
  });

  it("updates values when a bindable event is dispatched", async () => {
    let captured: Record<string, unknown> = {};
    const { container } = render(h(TestComponent, {
      onRender: (v) => { captured = v; },
    }));

    const el = container.querySelector(TAG)!;

    await act(() => {
      el.dispatchEvent(new CustomEvent("test-preact-input:value-changed", { detail: "hello" }));
    });
    expect(captured.value).toBe("hello");

    await act(() => {
      el.dispatchEvent(new CustomEvent("test-preact-input:checked-changed", { detail: true }));
    });
    expect(captured.checked).toBe(true);
  });

  it("stops listening after unmount", async () => {
    let captured: Record<string, unknown> = {};
    const { container, unmount } = render(h(TestComponent, {
      onRender: (v) => { captured = v; },
    }));

    const el = container.querySelector(TAG)!;

    await act(() => {
      el.dispatchEvent(new CustomEvent("test-preact-input:value-changed", { detail: "before" }));
    });
    expect(captured.value).toBe("before");

    unmount();

    el.dispatchEvent(new CustomEvent("test-preact-input:value-changed", { detail: "after" }));
    expect(captured.value).toBe("before");
  });

  it("handles non-bindable elements gracefully", () => {
    function NonBindable() {
      const [ref, values] = useWcBindable<HTMLDivElement>();
      return h("div", { ref, "data-testid": "plain" },
        JSON.stringify(values),
      );
    }

    const { getByTestId } = render(h(NonBindable, null));
    expect(getByTestId("plain").textContent).toBe("{}");
  });
});
