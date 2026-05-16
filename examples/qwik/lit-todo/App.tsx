import { component$ } from "@builder.io/qwik";
import { useWcBindable } from "../../../packages/qwik/src/index.ts";
import type { LitTodoElement, LitTodoValues } from "../../vanilla/lit-todo/types.ts";
import "../../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./App.tsx?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export const App = component$(() => {
  const { ref, values } = useWcBindable<LitTodoElement, LitTodoValues>({
    items: [],
    count: 0,
  });

  return (
    <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
      <p><a href="/index.html">&larr; Examples</a></p>
      <h1>wc-bindable: Qwik &mdash; Lit Todo</h1>

      <div style={card}>
        <div style={label}>
          Lit Todo Component
          {values.count != null && (
            <span style="display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px">
              {values.count}
            </span>
          )}
        </div>
        <lit-todo ref={ref}></lit-todo>
      </div>

      <div style={card}>
        <div style={label}>Bound Values (via useWcBindable)</div>
        <pre style="font-size: 14px; color: #2563eb">
          {JSON.stringify(values, null, 2)}
        </pre>
      </div>

      {values.items && values.items.length > 0 && (
        <div style={card}>
          <div style={label}>Qwik-rendered item list (from bound state)</div>
          <ul>
            {values.items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}

      <details style={card}>
        <summary style={label + "; cursor: pointer"}>Source Code</summary>
        <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px">
          <code>{appSource}</code>
        </pre>
      </details>
    </div>
  );
});
