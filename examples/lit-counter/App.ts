import { LitElement, html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { WcBindableController } from "../../packages/lit/src/index.ts";
import type { MyCounterElement, MyCounterValues } from "../vanilla/counter/types.ts";
import "../vanilla/counter/my-counter.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export class LitCounterApp extends LitElement {
  protected createRenderRoot() {
    return this;
  }

  private counterRef = createRef<MyCounterElement>();
  private counter = new WcBindableController<MyCounterValues>(
    this,
    () => this.counterRef.value,
  );

  render() {
    return html`
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
        <p><a href="/index.html">&larr; Examples</a></p>
        <h1>wc-bindable: Lit &mdash; Counter</h1>

        <div style="${card}">
          <div style="${label}">Counter Component</div>
          <my-counter ${ref(this.counterRef)}></my-counter>
        </div>

        <div style="${card}">
          <div style="${label}">Bound Values (via WcBindableController)</div>
          <pre style="font-size: 14px; color: #2563eb">${JSON.stringify(this.counter.values, null, 2)}</pre>
        </div>

        <details style="${card}">
          <summary style="${label}; cursor: pointer">Source Code</summary>
          <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>${appSource}</code></pre>
        </details>
      </div>
    `;
  }
}

customElements.define("lit-counter-app", LitCounterApp);
