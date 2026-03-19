import { bind, isWcBindable } from "../../packages/core/src/index.ts";
import "../vanilla/lit-todo/lit-todo.ts";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

document.getElementById("app")!.innerHTML = `
  <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Angular — Lit Todo</h1>
    <p style="color: #6b7280; font-size: 14px">
      Angular requires its own compiler/build pipeline and cannot run inside Vite directly.
      Below is the directive source and a plain-JS demo using the same <code>bind()</code> core that the directive wraps.
    </p>

    <div style="${card}">
      <div style="${label}">
        Lit Todo Component
        <span id="count-badge" style="display: none; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px"></span>
      </div>
      <lit-todo id="todo"></lit-todo>
    </div>

    <div style="${card}">
      <div style="${label}">Bound Values (via bind)</div>
      <pre id="values" style="font-size: 14px; color: #2563eb">{}</pre>
    </div>

    <div id="item-list-section" style="${card}; display: none">
      <div style="${label}">Item list rendered from bound state</div>
      <ul id="item-list"></ul>
    </div>

    <details style="${card}">
      <summary style="${label}; cursor: pointer">Angular Directive Source</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code id="source-code"></code></pre>
    </details>
  </div>
`;

const todo = document.getElementById("todo")!;
const valuesEl = document.getElementById("values")!;
const countBadge = document.getElementById("count-badge")!;
const itemListSection = document.getElementById("item-list-section")!;
const itemList = document.getElementById("item-list")!;
const values: Record<string, unknown> = {};

if (isWcBindable(todo)) {
  bind(todo, (name, value) => {
    values[name] = value;
    valuesEl.textContent = JSON.stringify(values, null, 2);

    if (name === "count") {
      if (value != null) {
        countBadge.textContent = String(value);
        countBadge.style.display = "inline-block";
      } else {
        countBadge.style.display = "none";
      }
    }

    if (name === "items") {
      const items = value as string[] | undefined;
      if (items && items.length > 0) {
        itemListSection.style.display = "";
        itemList.innerHTML = items.map((item) => `<li>${document.createElement("span").textContent = item, item}</li>`).join("");
        // Safe rendering
        itemList.innerHTML = "";
        for (const item of items) {
          const li = document.createElement("li");
          li.textContent = item;
          itemList.appendChild(li);
        }
      } else {
        itemListSection.style.display = "none";
      }
    }
  });
}

import("../../packages/angular/src/index.ts?raw").then((mod) => {
  document.getElementById("source-code")!.textContent = mod.default;
});
