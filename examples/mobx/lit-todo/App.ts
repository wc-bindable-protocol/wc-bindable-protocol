import { autorun } from "mobx";
import { createWcBindable } from "@wc-bindable/mobx";
import type { LitTodoValues } from "../../vanilla/lit-todo/types.ts";
import "../../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function mount(root: HTMLElement) {
  const binder = createWcBindable<LitTodoValues>({ items: [], count: 0 });

  const litTodo = document.createElement("lit-todo");

  const countBadge = document.createElement("span");
  countBadge.style.cssText = "display: none; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px";

  const valuesPre = document.createElement("pre");
  valuesPre.style.cssText = "font-size: 14px; color: #2563eb";

  const listCard = document.createElement("div");
  listCard.style.cssText = card;
  listCard.style.display = "none";
  const listLabel = document.createElement("div");
  listLabel.style.cssText = label;
  listLabel.textContent = "MobX-rendered item list (from bound state)";
  const listUl = document.createElement("ul");
  listCard.append(listLabel, listUl);

  const sourcePre = document.createElement("pre");
  sourcePre.style.cssText = "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px";
  const sourceCode = document.createElement("code");
  sourceCode.textContent = appSource;
  sourcePre.appendChild(sourceCode);

  root.innerHTML = `
    <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
      <p><a href="/index.html">← Examples</a></p>
      <h1>wc-bindable: MobX — Lit Todo</h1>
      <div style="${card}">
        <div style="${label}" id="component-label">Lit Todo Component</div>
        <div id="component-slot"></div>
      </div>
      <div style="${card}">
        <div style="${label}">Bound Values (via createWcBindable)</div>
        <div id="values-slot"></div>
      </div>
      <div id="list-slot"></div>
      <details style="${card}">
        <summary style="${label}; cursor: pointer">Source Code</summary>
        <div id="source-slot"></div>
      </details>
    </div>
  `;

  root.querySelector("#component-label")!.appendChild(countBadge);
  root.querySelector("#component-slot")!.appendChild(litTodo);
  root.querySelector("#values-slot")!.appendChild(valuesPre);
  root.querySelector("#list-slot")!.appendChild(listCard);
  root.querySelector("#source-slot")!.appendChild(sourcePre);

  // Bind AFTER <lit-todo> is connected so its connectedCallback() has run and
  // bind()'s initial sync reads post-connect property values.
  binder.bind(litTodo);

  autorun(() => {
    const count = binder.state.count;
    if (count != null) {
      countBadge.style.display = "inline-block";
      countBadge.textContent = String(count);
    } else {
      countBadge.style.display = "none";
    }
  });

  autorun(() => {
    valuesPre.textContent = JSON.stringify(
      {
        items: binder.state.items,
        count: binder.state.count,
      },
      null,
      2,
    );
  });

  autorun(() => {
    const items = binder.state.items ?? [];
    listCard.style.display = items.length === 0 ? "none" : "";
    listUl.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      }),
    );
  });
}
