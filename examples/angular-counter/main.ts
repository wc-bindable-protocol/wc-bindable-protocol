import { bind, isWcBindable } from "../../packages/core/src/index.ts";
import "../vanilla/counter/my-counter.js";
// @ts-expect-error vite raw import
import mainSource from "./main.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

document.getElementById("app")!.innerHTML = `
  <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Angular — Counter</h1>
    <p style="color: #6b7280; font-size: 14px">
      Angular requires its own compiler/build pipeline and cannot run inside Vite directly.
      Below is the directive source and a plain-JS demo using the same <code>bind()</code> core that the directive wraps.
    </p>

    <div style="${card}">
      <div style="${label}">Counter Component</div>
      <my-counter id="counter"></my-counter>
    </div>

    <div style="${card}">
      <div style="${label}">Bound Values (via bind)</div>
      <pre id="values" style="font-size: 14px; color: #2563eb">{}</pre>
    </div>

    <details style="${card}">
      <summary style="${label}; cursor: pointer">Angular Directive Source</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code id="source-code"></code></pre>
    </details>
  </div>
`;

// Use the same core bind() that WcBindableDirective uses internally
const counter = document.getElementById("counter")!;
const valuesEl = document.getElementById("values")!;
const values: Record<string, unknown> = {};

if (isWcBindable(counter)) {
  bind(counter, (name, value) => {
    values[name] = value;
    valuesEl.textContent = JSON.stringify(values, null, 2);
  });
}

// Show the Angular directive source code
import("../../packages/angular/src/index.ts?raw").then((mod) => {
  document.getElementById("source-code")!.textContent = mod.default;
});
