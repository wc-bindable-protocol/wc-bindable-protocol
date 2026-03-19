import { h } from "preact";
import { useWcBindable } from "../../packages/preact/src/index.ts";
import type { LitTodoElement, LitTodoValues } from "../vanilla/lit-todo/types.ts";
import "../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function App() {
  const [ref, values] = useWcBindable<LitTodoElement, LitTodoValues>();

  return h("div", { style: "font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px" },
    h("p", null, h("a", { href: "/index.html" }, "\u2190 Examples")),
    h("h1", null, "wc-bindable: Preact \u2014 Lit Todo"),

    h("div", { style: card },
      h("div", { style: label },
        "Lit Todo Component",
        values.count != null
          ? h("span", { style: "display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px" }, values.count)
          : null,
      ),
      h("lit-todo", { ref } as Record<string, unknown>),
    ),

    h("div", { style: card },
      h("div", { style: label }, "Bound Values (via useWcBindable)"),
      h("pre", { style: "font-size: 14px; color: #2563eb" }, JSON.stringify(values, null, 2)),
    ),

    values.items && values.items.length > 0
      ? h("div", { style: card },
          h("div", { style: label }, "Preact-rendered item list (from bound state)"),
          h("ul", null, values.items.map((item: string, i: number) => h("li", { key: i }, item))),
        )
      : null,

    h("details", { style: card },
      h("summary", { style: label + "; cursor: pointer" }, "Source Code"),
      h("pre", { style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px" },
        h("code", null, appSource),
      ),
    ),
  );
}
