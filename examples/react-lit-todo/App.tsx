import { useWcBindable } from "../../packages/react/src/index.ts";
import type { LitTodoElement, LitTodoValues } from "../vanilla/lit-todo/types.ts";
import "../vanilla/lit-todo/lit-todo.ts";

export function App() {
  const [ref, values] = useWcBindable<LitTodoElement, LitTodoValues>();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 600, margin: "40px auto", padding: "0 20px" }}>
      <p><a href="/index.html">&larr; Examples</a></p>
      <h1>wc-bindable: React — Lit Todo</h1>

      <div style={{ margin: "24px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Lit Todo Component
          {values.count != null && (
            <span style={{
              display: "inline-block", background: "#2563eb", color: "white",
              borderRadius: 12, padding: "2px 10px", fontSize: 13, marginLeft: 8,
            }}>
              {values.count}
            </span>
          )}
        </div>
        {/* @ts-expect-error custom element */}
        <lit-todo ref={ref} />
      </div>

      <div style={{ margin: "24px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Bound Values (via useWcBindable)</div>
        <pre style={{ fontSize: 14, color: "#2563eb" }}>
          {JSON.stringify(values, null, 2)}
        </pre>
      </div>

      {values.items && values.items.length > 0 && (
        <div style={{ margin: "24px 0", padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>React-rendered item list (from bound state)</div>
          <ul>
            {values.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
