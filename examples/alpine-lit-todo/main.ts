import Alpine from "alpinejs";
import wcBindable from "../../packages/alpine/src/index.ts";
import "../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./app.html?raw";

Alpine.plugin(wcBindable);

document.getElementById("app")!.innerHTML = `
  <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px"
    x-data="{ items: [], count: null }">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Alpine — Lit Todo</h1>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">
        Lit Todo Component
        <template x-if="count != null">
          <span style="display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px"
            x-text="count"></span>
        </template>
      </div>
      <lit-todo x-wc-bindable></lit-todo>
    </div>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Bound Values (via x-wc-bindable)</div>
      <pre style="font-size: 14px; color: #2563eb" x-text="JSON.stringify({ items, count }, null, 2)"></pre>
    </div>

    <template x-if="items && items.length > 0">
      <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
        <div style="font-weight: 600; margin-bottom: 8px">Alpine-rendered item list (from bound state)</div>
        <ul>
          <template x-for="(item, i) in items" :key="i">
            <li x-text="item"></li>
          </template>
        </ul>
      </div>
    </template>

    <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code id="source-code"></code></pre>
    </details>
  </div>
`;

document.getElementById("source-code")!.textContent = appSource;

Alpine.start();
