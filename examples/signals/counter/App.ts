import { createWcBindable } from "@wc-bindable/signals";
import type { MyCounterValues } from "../../vanilla/counter/types.ts";
import "../../vanilla/counter/my-counter.js";
import { effect } from "../effect.ts";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function mount(root: HTMLElement) {
  const binder = createWcBindable<MyCounterValues>({ count: 0 });

  const myCounter = document.createElement("my-counter");

  const valuesPre = document.createElement("pre");
  valuesPre.style.cssText = "font-size: 14px; color: #2563eb";

  const sourcePre = document.createElement("pre");
  sourcePre.style.cssText = "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px";
  const sourceCode = document.createElement("code");
  sourceCode.textContent = appSource;
  sourcePre.appendChild(sourceCode);

  root.innerHTML = `
    <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
      <p><a href="/index.html">← Examples</a></p>
      <h1>wc-bindable: Signals — Counter</h1>
      <div id="component-card" style="${card}">
        <div style="${label}">Counter Component</div>
      </div>
      <div style="${card}">
        <div style="${label}">Bound Values (via createWcBindable)</div>
        <div id="values-slot"></div>
      </div>
      <details style="${card}">
        <summary style="${label}; cursor: pointer">Source Code</summary>
        <div id="source-slot"></div>
      </details>
    </div>
  `;

  root.querySelector("#component-card")!.appendChild(myCounter);
  root.querySelector("#values-slot")!.appendChild(valuesPre);
  root.querySelector("#source-slot")!.appendChild(sourcePre);

  // Bind AFTER the element is in the DOM so connectedCallback() has run and
  // bind()'s initial sync reads post-connect property values.
  binder.bind(myCounter);

  effect(() => {
    valuesPre.textContent = JSON.stringify(
      { count: binder.signals.count.get() },
      null,
      2,
    );
  });
}
