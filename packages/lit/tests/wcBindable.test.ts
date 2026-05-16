import { describe, it, expect, vi } from "vitest";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { WcBindableController } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "lit-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "lit-test-input:value-changed" },
      { name: "checked", event: "lit-test-input:checked-changed" },
    ],
  };
  class LitTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, LitTestInput);
}

function createFakeHost(): {
  host: ReactiveControllerHost;
  controllers: ReactiveController[];
  requestUpdate: ReturnType<typeof vi.fn>;
} {
  const controllers: ReactiveController[] = [];
  const requestUpdate = vi.fn();
  const host: ReactiveControllerHost = {
    addController(c) { controllers.push(c); },
    removeController(c) {
      const i = controllers.indexOf(c);
      if (i >= 0) controllers.splice(i, 1);
    },
    requestUpdate,
    updateComplete: Promise.resolve(true),
  };
  return { host, controllers, requestUpdate };
}

describe("WcBindableController", () => {
  it("registers itself with the host on construction", () => {
    const { host, controllers } = createFakeHost();
    const el = document.createElement(TAG);

    const c = new WcBindableController(host, el);

    expect(controllers).toContain(c);
  });

  it("exposes the provided initial values before any event", () => {
    const { host } = createFakeHost();
    const el = document.createElement(TAG);

    const c = new WcBindableController<{ value: string; checked: boolean }>(
      host,
      el,
      { value: "", checked: false },
    );

    expect(c.values).toEqual({ value: "", checked: false });
  });

  it("updates values and requests a host update on bindable events", () => {
    const { host, requestUpdate } = createFakeHost();
    const el = document.createElement(TAG);

    const c = new WcBindableController<{ value: string; checked: boolean }>(
      host,
      el,
      { value: "", checked: false },
    );

    c.hostConnected();

    el.dispatchEvent(
      new CustomEvent("lit-test-input:value-changed", { detail: "hello" }),
    );
    expect(c.values.value).toBe("hello");

    el.dispatchEvent(
      new CustomEvent("lit-test-input:checked-changed", { detail: true }),
    );
    expect(c.values.checked).toBe(true);

    expect(requestUpdate).toHaveBeenCalled();
  });

  it("stops listening after hostDisconnected", () => {
    const { host, requestUpdate } = createFakeHost();
    const el = document.createElement(TAG);

    const c = new WcBindableController<{ value: string }>(host, el, {
      value: "",
    });

    c.hostConnected();
    el.dispatchEvent(
      new CustomEvent("lit-test-input:value-changed", { detail: "before" }),
    );
    expect(c.values.value).toBe("before");

    c.hostDisconnected();
    requestUpdate.mockClear();

    el.dispatchEvent(
      new CustomEvent("lit-test-input:value-changed", { detail: "after" }),
    );
    expect(c.values.value).toBe("before");
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("rebinds when the target getter returns a different element", () => {
    const { host } = createFakeHost();
    const first = document.createElement(TAG);
    const second = document.createElement(TAG);
    let current: HTMLElement = first;

    const c = new WcBindableController<{ value: string }>(host, () => current, {
      value: "",
    });

    c.hostConnected();
    first.dispatchEvent(
      new CustomEvent("lit-test-input:value-changed", { detail: "from-first" }),
    );
    expect(c.values.value).toBe("from-first");

    current = second;
    c.hostUpdated();

    second.dispatchEvent(
      new CustomEvent("lit-test-input:value-changed", { detail: "from-second" }),
    );
    expect(c.values.value).toBe("from-second");

    first.dispatchEvent(
      new CustomEvent("lit-test-input:value-changed", { detail: "ignored" }),
    );
    expect(c.values.value).toBe("from-second");
  });

  it("does not bind when the target is missing or not bindable", () => {
    const { host, requestUpdate } = createFakeHost();

    const missing = new WcBindableController(host, null);
    missing.hostConnected();
    expect(requestUpdate).not.toHaveBeenCalled();

    const plain = document.createElement("div");
    const c = new WcBindableController(host, plain);
    c.hostConnected();
    plain.dispatchEvent(new CustomEvent("anything", { detail: "x" }));
    expect(requestUpdate).not.toHaveBeenCalled();

    c.hostDisconnected();
  });

  it("binds on a later hostUpdated when the target becomes wc-bindable in place", () => {
    const { host, requestUpdate } = createFakeHost();

    class LateClass extends HTMLElement {}
    const lateTag = "lit-test-late-upgrade";
    if (!customElements.get(lateTag)) customElements.define(lateTag, LateClass);

    const el = document.createElement(lateTag);

    const c = new WcBindableController<{ value: string }>(host, el, { value: "" });
    c.hostConnected();

    el.dispatchEvent(
      new CustomEvent("lit-test-late-upgrade:value-changed", { detail: "early" }),
    );
    expect(c.values.value).toBe("");
    expect(requestUpdate).not.toHaveBeenCalled();

    (LateClass as unknown as { wcBindable: WcBindableDeclaration }).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "lit-test-late-upgrade:value-changed" },
      ],
    };

    c.hostUpdated();

    el.dispatchEvent(
      new CustomEvent("lit-test-late-upgrade:value-changed", { detail: "after" }),
    );
    expect(c.values.value).toBe("after");
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("performs an initial sync from properties already present on the element", () => {
    const { host, requestUpdate } = createFakeHost();
    const el = document.createElement(TAG) as HTMLElement & { value?: string };
    el.value = "preset";

    const c = new WcBindableController<{ value: string }>(host, el);
    c.hostConnected();

    expect(c.values.value).toBe("preset");
    expect(requestUpdate).toHaveBeenCalled();
  });
});
