import { LitElement, html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { WcBindableController } from "../../../packages/lit/src/index.ts";
import type { MyFetchElement, MyFetchValues } from "../../vanilla/fetch/types.ts";
import "../../vanilla/fetch/my-fetch.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const section = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export class LitFetchApp extends LitElement {
  static override properties = {
    url: { state: true },
  };

  protected createRenderRoot() {
    return this;
  }

  url = "https://jsonplaceholder.typicode.com/posts/1";

  private fetchRef = createRef<MyFetchElement>();
  private fetcher = new WcBindableController<MyFetchValues>(
    this,
    () => this.fetchRef.value,
  );

  private handleFetch = () => {
    const el = this.fetchRef.value;
    if (!el) return;
    el.url = this.url;
    el.fetch();
  };

  private handleAbort = () => {
    this.fetchRef.value?.abort();
  };

  render() {
    const v = this.fetcher.values;
    return html`
      <div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px">
        <p><a href="/index.html">&larr; Examples</a></p>
        <h1>wc-bindable: Lit &mdash; Fetch</h1>

        <my-fetch ${ref(this.fetchRef)} manual></my-fetch>

        <div style="${section}">
          <div style="${label}">Request</div>
          <div style="display: flex; gap: 8px; align-items: center">
            <input
              type="text"
              .value=${this.url}
              @input=${(e: Event) => (this.url = (e.target as HTMLInputElement).value)}
              style="flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px"
            />
            <button
              @click=${this.handleFetch}
              ?disabled=${!!v.loading}
              style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer"
            >
              Fetch
            </button>
            <button
              @click=${this.handleAbort}
              style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer"
            >
              Abort
            </button>
          </div>
        </div>

        <div style="${section}">
          <div style="${label}">Bound State (via WcBindableController)</div>
          <div style="display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px">
            <span style="padding: 2px 8px; border-radius: 4px; background: ${v.loading ? "#fef3c7" : "#d1fae5"}; color: ${v.loading ? "#92400e" : "#065f46"}">
              loading: <strong>${String(v.loading ?? false)}</strong>
            </span>
            <span>status: <strong>${String(v.status ?? "-")}</strong></span>
          </div>
          ${v.error
            ? html`<div style="background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px">${JSON.stringify(v.error, null, 2)}</div>`
            : null}
          <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word">${v.value ? JSON.stringify(v.value, null, 2) : "- No response yet -"}</pre>
        </div>

        <details style="${section}">
          <summary style="${label}; cursor: pointer">Source Code</summary>
          <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>${appSource}</code></pre>
        </details>
      </div>
    `;
  }
}

customElements.define("lit-fetch-app", LitFetchApp);

