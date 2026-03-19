import { For, Show } from "solid-js";
import { createWcBindable } from "../../packages/solid/src/index.ts";
import "../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./App.tsx?raw";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "lit-todo": { ref?: (el: HTMLElement) => void };
    }
  }
}

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function App() {
  const [values, directive] = createWcBindable();

  return (
    <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
      <p><a href="/index.html">&larr; Examples</a></p>
      <h1>wc-bindable: Solid — Lit Todo</h1>

      <div style={card}>
        <div style={label}>
          Lit Todo Component
          <Show when={values().count != null}>
            <span style="display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px">
              {values().count}
            </span>
          </Show>
        </div>
        <lit-todo ref={directive} />
      </div>

      <div style={card}>
        <div style={label}>Bound Values (via createWcBindable)</div>
        <pre style="font-size: 14px; color: #2563eb">
          {JSON.stringify(values(), null, 2)}
        </pre>
      </div>

      <Show when={values().items && (values().items as string[]).length > 0}>
        <div style={card}>
          <div style={label}>Solid-rendered item list (from bound state)</div>
          <ul>
            <For each={values().items as string[]}>
              {(item) => <li>{item}</li>}
            </For>
          </ul>
        </div>
      </Show>

      <details style={card}>
        <summary style={label + "; cursor: pointer"}>Source Code</summary>
        <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px">
          <code>{appSource}</code>
        </pre>
      </details>
    </div>
  );
}
