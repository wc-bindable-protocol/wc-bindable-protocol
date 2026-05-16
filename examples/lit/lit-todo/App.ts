import { LitElement, html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { WcBindableController } from "../../../packages/lit/src/index.ts";
import type { LitTodoElement, LitTodoValues } from "../../vanilla/lit-todo/types.ts";
import "../../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export class LitTodoApp extends LitElement {
  protected createRenderRoot() {
    return this;
  }

  private todoRef = createRef<LitTodoElement>();
  private todo = new WcBindableController<LitTodoValues>(
    this,
    () => this.todoRef.value,
    { items: [], count: 0 },
  );

  render() {
    const v = this.todo.values;
    return html`
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
        <p><a href="/index.html">&larr; Examples</a></p>
        <h1>wc-bindable: Lit &mdash; Lit Todo</h1>

        <div style="${card}">
          <div style="${label}">
            Lit Todo Component
            ${v.count != null
              ? html`<span style="display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px">${v.count}</span>`
              : null}
          </div>
          <lit-todo ${ref(this.todoRef)}></lit-todo>
        </div>

        <div style="${card}">
          <div style="${label}">Bound Values (via WcBindableController)</div>
          <pre style="font-size: 14px; color: #2563eb">${JSON.stringify(v, null, 2)}</pre>
        </div>

        ${v.items && v.items.length > 0
          ? html`
              <div style="${card}">
                <div style="${label}">Lit-rendered item list (from bound state)</div>
                <ul>${v.items.map((item) => html`<li>${item}</li>`)}</ul>
              </div>
            `
          : null}

        <details style="${card}">
          <summary style="${label}; cursor: pointer">Source Code</summary>
          <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>${appSource}</code></pre>
        </details>
      </div>
    `;
  }
}

customElements.define("lit-todo-app", LitTodoApp);

