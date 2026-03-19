import { createSignal } from "solid-js";
import { createWcBindable } from "../../packages/solid/src/index.ts";
import "../vanilla/fetch/my-fetch.js";
// @ts-expect-error vite raw import
import appSource from "./App.tsx?raw";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "my-fetch": { ref?: (el: HTMLElement) => void; manual?: boolean };
    }
  }
}

const section = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function App() {
  const [url, setUrl] = createSignal("https://jsonplaceholder.typicode.com/posts/1");
  const [values, directive] = createWcBindable();
  let fetchEl: HTMLElement | undefined;

  const ref = (el: HTMLElement) => {
    fetchEl = el;
    directive(el);
  };

  const handleFetch = () => {
    const el = fetchEl as any;
    if (el) { el.url = url(); el.fetch(); }
  };

  const handleAbort = () => { (fetchEl as any)?.abort(); };

  return (
    <div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px">
      <p><a href="/index.html">&larr; Examples</a></p>
      <h1>wc-bindable: Solid — Fetch</h1>

      <my-fetch ref={ref} manual />

      <div style={section}>
        <div style={label}>Request</div>
        <div style="display: flex; gap: 8px; align-items: center">
          <input
            type="text"
            value={url()}
            onInput={(e) => setUrl(e.currentTarget.value)}
            style="flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px"
          />
          <button onClick={handleFetch} disabled={!!values().loading}
            style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
            Fetch
          </button>
          <button onClick={handleAbort}
            style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
            Abort
          </button>
        </div>
      </div>

      <div style={section}>
        <div style={label}>Bound State (via createWcBindable)</div>
        <div style="display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px">
          <span style={`padding: 2px 8px; border-radius: 4px; background: ${values().loading ? "#fef3c7" : "#d1fae5"}; color: ${values().loading ? "#92400e" : "#065f46"}`}>
            loading: <strong>{String(values().loading ?? false)}</strong>
          </span>
          <span>status: <strong>{String(values().status ?? "\u2014")}</strong></span>
        </div>
        {values().error && (
          <div style="background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px">
            {JSON.stringify(values().error, null, 2)}
          </div>
        )}
        <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word">
          {values().value ? JSON.stringify(values().value, null, 2) : "\u2014 No response yet \u2014"}
        </pre>
      </div>

      <details style={section}>
        <summary style={label + "; cursor: pointer"}>Source Code</summary>
        <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px">
          <code>{appSource}</code>
        </pre>
      </details>
    </div>
  );
}
