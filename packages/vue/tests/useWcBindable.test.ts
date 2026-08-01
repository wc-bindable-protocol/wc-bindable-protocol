import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { useWcBindable } from "../src/index.js";
import type { WcBindableDeclaration } from "@wc-bindable/core";

const TAG = "vue-test-input";

if (!customElements.get(TAG)) {
  const decl: WcBindableDeclaration = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "vue-test-input:value-changed" },
      { name: "checked", event: "vue-test-input:checked-changed" },
    ],
  };
  class VueTestInput extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(TAG, VueTestInput);
}

describe("useWcBindable (Vue)", () => {
  it("returns initial values before any event", () => {
    const Comp = defineComponent({
      setup() {
        const { ref, values } = useWcBindable<HTMLElement>({ value: "", checked: false });
        return { elRef: ref, values };
      },
      render() {
        return h(TAG, { ref: "elRef" });
      },
    });

    const wrapper = mount(Comp);
    expect(wrapper.vm.values.value).toBe("");
    expect(wrapper.vm.values.checked).toBe(false);
  });

  it("updates values when a bindable event is dispatched", async () => {
    const Comp = defineComponent({
      setup() {
        const { ref, values } = useWcBindable<HTMLElement>({ value: "" });
        return { elRef: ref, values };
      },
      render() {
        return h(TAG, { ref: "elRef" });
      },
    });

    const wrapper = mount(Comp, { attachTo: document.body });
    const el = wrapper.element as HTMLElement;

    el.dispatchEvent(new CustomEvent("vue-test-input:value-changed", { detail: "hello" }));
    await nextTick();
    expect(wrapper.vm.values.value).toBe("hello");

    el.dispatchEvent(new CustomEvent("vue-test-input:checked-changed", { detail: true }));
    await nextTick();
    expect(wrapper.vm.values.checked).toBe(true);

    wrapper.unmount();
  });

  it("stops listening after unmount", async () => {
    const Comp = defineComponent({
      setup() {
        const { ref, values } = useWcBindable<HTMLElement>({ value: "" });
        return { elRef: ref, values };
      },
      render() {
        return h(TAG, { ref: "elRef" });
      },
    });

    const wrapper = mount(Comp, { attachTo: document.body });
    const el = wrapper.element as HTMLElement;

    el.dispatchEvent(new CustomEvent("vue-test-input:value-changed", { detail: "before" }));
    await nextTick();
    expect(wrapper.vm.values.value).toBe("before");

    wrapper.unmount();

    el.dispatchEvent(new CustomEvent("vue-test-input:value-changed", { detail: "after" }));
    await nextTick();
    // values object still exists in memory but should not have been updated
    expect(wrapper.vm.values.value).toBe("before");
  });

  it("handles non-bindable elements gracefully", () => {
    const Comp = defineComponent({
      setup() {
        const { ref, values } = useWcBindable<HTMLDivElement>();
        return { elRef: ref, values };
      },
      render() {
        return h("div", { ref: "elRef" });
      },
    });

    const wrapper = mount(Comp);
    expect(Object.keys(wrapper.vm.values)).toHaveLength(0);
  });

  it("binds an element whose definition arrives after onMounted", async () => {
    // happy-dom does not implement custom element upgrade, so the swap
    // below stands in for the one a real browser performs inside
    // `define()`. See packages/core/tests/index.test.ts § syncOn: define.
    const tag = "vue-test-late";
    const Comp = defineComponent({
      setup() {
        const { ref, values } = useWcBindable<HTMLElement>({ value: "" });
        return { elRef: ref, values };
      },
      render() {
        return h(tag, { ref: "elRef" });
      },
    });

    const wrapper = mount(Comp);
    const el = wrapper.element as HTMLElement;

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "early" }));
    await nextTick();
    expect(wrapper.vm.values.value).toBe("");

    const Cls = class extends HTMLElement {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: `${tag}:value-changed` }],
      };
    };
    customElements.define(tag, Cls);
    Object.setPrototypeOf(el, Cls.prototype);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    // onMounted does not run again — the deferred bind completed alone.
    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    await nextTick();
    expect(wrapper.vm.values.value).toBe("after");
  });

  it("syncOn: \"call\" opts back into skipping a not-yet-upgraded element", async () => {
    const tag = "vue-test-late-optout";
    const Comp = defineComponent({
      setup() {
        const { ref, values } = useWcBindable<HTMLElement>({ value: "" }, { syncOn: "call" });
        return { elRef: ref, values };
      },
      render() {
        return h(tag, { ref: "elRef" });
      },
    });

    const wrapper = mount(Comp);
    const el = wrapper.element as HTMLElement;

    const Cls = class extends HTMLElement {
      static wcBindable: WcBindableDeclaration = {
        protocol: "wc-bindable",
        version: 1,
        properties: [{ name: "value", event: `${tag}:value-changed` }],
      };
    };
    customElements.define(tag, Cls);
    Object.setPrototypeOf(el, Cls.prototype);
    await customElements.whenDefined(tag);
    await Promise.resolve();

    el.dispatchEvent(new CustomEvent(`${tag}:value-changed`, { detail: "after" }));
    await nextTick();
    expect(wrapper.vm.values.value).toBe("");
  });
});
