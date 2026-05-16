import { describe, it, expect, beforeAll } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";
// @ts-expect-error - .marko files are compiled by the @marko/vite plugin at runtime
import template from "./fixtures/bindable-host.marko";

const TAG = "integration-input";

beforeAll(() => {
  if (!customElements.get(TAG)) {
    const decl: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "value", event: "integration-input:value-changed" },
      ],
    };
    class IntegrationInput extends HTMLElement {
      static wcBindable = decl;
    }
    customElements.define(TAG, IntegrationInput);
  }
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("Marko template integration", () => {
  it("rebinds the rendered DOM through the Marko component lifecycle", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    const instance = template.renderSync({}).appendTo(host).getComponent();
    await flush();

    const inputEl = host.querySelector(TAG)!;
    expect(inputEl).toBeTruthy();

    inputEl.dispatchEvent(
      new CustomEvent("integration-input:value-changed", { detail: "hello" }),
    );
    await flush();

    const out = host.querySelector('[data-testid="out"]')!;
    expect(out.textContent).toBe("hello");

    inputEl.dispatchEvent(
      new CustomEvent("integration-input:value-changed", { detail: "world" }),
    );
    await flush();
    expect(out.textContent).toBe("world");

    instance.destroy();
    inputEl.dispatchEvent(
      new CustomEvent("integration-input:value-changed", { detail: "ignored" }),
    );
    await flush();
    expect(out.textContent).toBe("world");

    host.remove();
  });
});
