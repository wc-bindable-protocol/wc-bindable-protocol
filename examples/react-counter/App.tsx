import { useWcBindable } from "../../packages/react/src/index.ts";
import type { MyCounterValues } from "../vanilla/counter/types.ts";
import "../vanilla/counter/my-counter.js";

export function App() {
  const [ref, values] = useWcBindable<HTMLElement, MyCounterValues>();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 600, margin: "40px auto", padding: "0 20px" }}>
      <p><a href="/index.html">&larr; Examples</a></p>
      <h1>wc-bindable: React — Counter</h1>

      <div style={{ margin: "24px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Counter Component</div>
        {/* @ts-expect-error custom element */}
        <my-counter ref={ref} />
      </div>

      <div style={{ margin: "24px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Bound Values (via useWcBindable)</div>
        <pre style={{ fontSize: 14, color: "#2563eb" }}>
          {JSON.stringify(values, null, 2)}
        </pre>
      </div>
    </div>
  );
}
