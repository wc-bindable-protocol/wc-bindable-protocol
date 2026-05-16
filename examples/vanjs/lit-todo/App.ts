import van from "vanjs-core";
import { createWcBindable } from "@wc-bindable/vanjs";
import type { LitTodoValues } from "../../vanilla/lit-todo/types.ts";
import "../../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const { a, code, details, div, h1, li, p, pre, span, summary, ul } = van.tags;

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export const App = () => {
  const binder = createWcBindable<LitTodoValues>({ items: [], count: 0 });

  const litTodo = document.createElement("lit-todo");
  // Defer until after van.add() inserts the element, so connectedCallback()
  // has run and bind()'s initial sync reads post-connect property values.
  queueMicrotask(() => binder.bind(litTodo));

  return div(
    { style: "font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px" },
    p(a({ href: "/index.html" }, "← Examples")),
    h1("wc-bindable: VanJS — Lit Todo"),

    div({ style: card },
      div({ style: label },
        "Lit Todo Component",
        () => {
          const count = binder.states.count.val;
          return count != null
            ? span(
                { style: "display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px" },
                String(count),
              )
            : span({ style: "display: none" });
        },
      ),
      litTodo,
    ),

    div({ style: card },
      div({ style: label }, "Bound Values (via createWcBindable)"),
      pre(
        { style: "font-size: 14px; color: #2563eb" },
        () => JSON.stringify({
          items: binder.states.items.val,
          count: binder.states.count.val,
        }, null, 2),
      ),
    ),

    () => {
      const items = binder.states.items.val ?? [];
      if (items.length === 0) return div({ style: "display: none" });
      return div({ style: card },
        div({ style: label }, "VanJS-rendered item list (from bound state)"),
        ul(items.map((item) => li(item))),
      );
    },

    details({ style: card },
      summary({ style: label + "; cursor: pointer" }, "Source Code"),
      pre(
        { style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px" },
        code(appSource),
      ),
    ),
  );
};
