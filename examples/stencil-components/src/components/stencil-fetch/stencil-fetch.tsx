import { Component, State, h } from "@stencil/core";
import { WcBindableController } from "@wc-bindable/stencil";
import { parseStyle } from "../../util/parse-style";

interface MyFetchValues {
  value: unknown;
  loading: boolean;
  error: { status: number; statusText: string; body: string } | null;
  status: number;
}

interface MyFetchElement extends HTMLElement {
  url: string;
  method: string;
  manual: boolean;
  fetch(): Promise<unknown>;
  abort(): void;
}

const section =
  "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

@Component({ tag: "stencil-fetch-app", shadow: false })
export class StencilFetchApp {
  @State() url = "https://jsonplaceholder.typicode.com/posts/1";

  private fetchRef?: MyFetchElement;
  private fetcher = new WcBindableController<MyFetchValues>(
    this,
    () => this.fetchRef,
  );

  connectedCallback() {
    this.fetcher.connect();
  }

  disconnectedCallback() {
    this.fetcher.disconnect();
  }

  componentDidRender() {
    this.fetcher.update();
  }

  private handleFetch = () => {
    const el = this.fetchRef;
    if (!el) return;
    el.url = this.url;
    el.fetch();
  };

  private handleAbort = () => {
    this.fetchRef?.abort();
  };

  render() {
    const v = this.fetcher.values;
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: "700px", margin: "40px auto", padding: "0 20px" }}>
        <p><a href="/index.html">&larr; Examples</a></p>
        <h1>wc-bindable: Stencil &mdash; Fetch</h1>

        <my-fetch
          ref={(el?: HTMLElement) => (this.fetchRef = el as MyFetchElement | undefined)}
          manual
        ></my-fetch>

        <div style={parseStyle(section)}>
          <div style={parseStyle(label)}>Request</div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              type="text"
              value={this.url}
              onInput={(e: Event) => (this.url = (e.target as HTMLInputElement).value)}
              style={{ flex: "1", padding: "6px 10px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "14px" }}
            />
            <button
              onClick={this.handleFetch}
              disabled={!!v.loading}
              style={{ padding: "6px 16px", border: "1px solid #ccc", borderRadius: "4px", background: "#f5f5f5", cursor: "pointer" }}
            >
              Fetch
            </button>
            <button
              onClick={this.handleAbort}
              style={{ padding: "6px 16px", border: "1px solid #ccc", borderRadius: "4px", background: "#f5f5f5", cursor: "pointer" }}
            >
              Abort
            </button>
          </div>
        </div>

        <div style={parseStyle(section)}>
          <div style={parseStyle(label)}>Bound State (via WcBindableController)</div>
          <div style={{ display: "flex", gap: "16px", fontSize: "14px", marginBottom: "8px" }}>
            <span style={{
              padding: "2px 8px",
              borderRadius: "4px",
              background: v.loading ? "#fef3c7" : "#d1fae5",
              color: v.loading ? "#92400e" : "#065f46",
            }}>
              loading: <strong>{String(v.loading ?? false)}</strong>
            </span>
            <span>status: <strong>{String(v.status ?? "—")}</strong></span>
          </div>
          {v.error ? (
            <div style={{ background: "#fee2e2", color: "#991b1b", padding: "8px", borderRadius: "4px", marginBottom: "8px" }}>
              {JSON.stringify(v.error, null, 2)}
            </div>
          ) : null}
          <pre style={{
            background: "#f5f5f5",
            padding: "12px",
            borderRadius: "4px",
            maxHeight: "300px",
            overflow: "auto",
            fontSize: "13px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {v.value ? JSON.stringify(v.value, null, 2) : "— No response yet —"}
          </pre>
        </div>
      </div>
    );
  }
}
