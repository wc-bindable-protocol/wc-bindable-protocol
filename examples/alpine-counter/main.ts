import Alpine from "alpinejs";
import wcBindable from "../../packages/alpine/src/index.ts";
import "../vanilla/counter/my-counter.js";
// @ts-expect-error vite raw import
import appSource from "./app.html?raw";

Alpine.plugin(wcBindable);

document.getElementById("app")!.innerHTML = `
  <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Alpine — Counter</h1>

    <div x-data="{ count: 0 }"
      style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Counter Component</div>
      <my-counter x-wc-bindable></my-counter>

      <div style="margin-top: 16px; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
        <div style="font-weight: 600; margin-bottom: 8px">Bound Values (via x-wc-bindable)</div>
        <pre style="font-size: 14px; color: #2563eb" x-text="JSON.stringify({ count }, null, 2)"></pre>
      </div>
    </div>

    <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code id="source-code"></code></pre>
    </details>
  </div>
`;

document.getElementById("source-code")!.textContent = appSource;

Alpine.start();
