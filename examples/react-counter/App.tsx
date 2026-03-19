import { useWcBindable } from "../../packages/react/src/index.ts";
import type { MyCounterElement, MyCounterValues } from "../vanilla/counter/types.ts";
import "../vanilla/counter/my-counter.js";
// @ts-expect-error vite raw import
import appSource from "./App.tsx?raw";

const cardStyle = { margin: "24px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 };
const labelStyle = { fontWeight: 600, marginBottom: 8 } as const;

export function App() {
  const [ref, values] = useWcBindable<MyCounterElement, MyCounterValues>();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 600, margin: "40px auto", padding: "0 20px" }}>
      <p><a href="/index.html">&larr; Examples</a></p>
      <h1>wc-bindable: React — Counter</h1>

      <div style={cardStyle}>
        <div style={labelStyle}>Counter Component</div>
        {/* @ts-expect-error custom element */}
        <my-counter ref={ref} />
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>Bound Values (via useWcBindable)</div>
        <pre style={{ fontSize: 14, color: "#2563eb" }}>
          {JSON.stringify(values, null, 2)}
        </pre>
      </div>

      <details style={cardStyle}>
        <summary style={{ ...labelStyle, cursor: "pointer" }}>Source Code</summary>
        <pre style={{ fontSize: 13, overflow: "auto", margin: "8px 0 0", padding: 12, background: "#f8fafc", borderRadius: 4 }}>
          <code>{appSource}</code>
        </pre>
      </details>
    </div>
  );
}
