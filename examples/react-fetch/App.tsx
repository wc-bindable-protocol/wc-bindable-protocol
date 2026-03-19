import { useCallback, useRef, useState } from "react";
import { useWcBindable } from "../../packages/react/src/index.ts";
import type { MyFetchElement, MyFetchValues } from "../vanilla/fetch/types.ts";
import "../vanilla/fetch/my-fetch.js";
// @ts-expect-error vite raw import
import appSource from "./App.tsx?raw";

const section = { margin: "24px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 } as const;
const label = { fontWeight: 600, marginBottom: 8 } as const;

export function App() {
  const [url, setUrl] = useState("https://jsonplaceholder.typicode.com/posts/1");
  const [bindRef, values] = useWcBindable<MyFetchElement, MyFetchValues>();
  const elRef = useRef<MyFetchElement | null>(null);

  const ref = useCallback((node: MyFetchElement | null) => {
    elRef.current = node;
    bindRef(node);
  }, [bindRef]);

  const handleFetch = useCallback(() => {
    const el = elRef.current;
    if (el) {
      el.url = url;
      el.fetch();
    }
  }, [url]);

  const handleAbort = useCallback(() => {
    elRef.current?.abort();
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 700, margin: "40px auto", padding: "0 20px" }}>
      <p><a href="/index.html">&larr; Examples</a></p>
      <h1>wc-bindable: React — Fetch</h1>

      {/* @ts-expect-error custom element */}
      <my-fetch ref={ref} manual />

      <div style={section}>
        <div style={label}>Request</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1, padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4, fontSize: 14 }}
          />
          <button onClick={handleFetch} disabled={!!values.loading}
            style={{ padding: "6px 16px", border: "1px solid #ccc", borderRadius: 4, background: "#f5f5f5", cursor: "pointer" }}>
            Fetch
          </button>
          <button onClick={handleAbort}
            style={{ padding: "6px 16px", border: "1px solid #ccc", borderRadius: 4, background: "#f5f5f5", cursor: "pointer" }}>
            Abort
          </button>
        </div>
      </div>

      <div style={section}>
        <div style={label}>Bound State (via useWcBindable)</div>
        <div style={{ display: "flex", gap: 16, fontSize: 14, marginBottom: 8 }}>
          <span style={{
            padding: "2px 8px", borderRadius: 4,
            background: values.loading ? "#fef3c7" : "#d1fae5",
            color: values.loading ? "#92400e" : "#065f46",
          }}>
            loading: <strong>{String(values.loading ?? false)}</strong>
          </span>
          <span>status: <strong>{String(values.status ?? "—")}</strong></span>
        </div>
        {values.error && (
          <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 4, marginBottom: 8 }}>
            {JSON.stringify(values.error, null, 2)}
          </div>
        )}
        <pre style={{ background: "#f5f5f5", padding: 12, borderRadius: 4, maxHeight: 300, overflow: "auto", fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {values.value ? JSON.stringify(values.value, null, 2) : "— No response yet —"}
        </pre>
      </div>

      <details style={section}>
        <summary style={{ ...label, cursor: "pointer" }}>Source Code</summary>
        <pre style={{ fontSize: 13, overflow: "auto", margin: "8px 0 0", padding: 12, background: "#f8fafc", borderRadius: 4 }}>
          <code>{appSource}</code>
        </pre>
      </details>
    </div>
  );
}
