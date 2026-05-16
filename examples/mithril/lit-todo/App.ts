import m from "mithril";
import { createWcBindable } from "@wc-bindable/mithril";
import type { LitTodoValues } from "../../vanilla/lit-todo/types.ts";
import "../../vanilla/lit-todo/lit-todo.ts";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export const App = () => {
  const binder = createWcBindable<LitTodoValues>({ items: [], count: 0 });

  return {
    view: () => {
      const items = binder.values.items ?? [];
      const count = binder.values.count;
      return m("div", { style: "font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px" }, [
        m("p", m("a", { href: "/index.html" }, "← Examples")),
        m("h1", "wc-bindable: Mithril — Lit Todo"),

        m("div", { style: card }, [
          m("div", { style: label }, [
            "Lit Todo Component",
            count != null && m("span", {
              style: "display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px",
            }, String(count)),
          ]),
          m("lit-todo", {
            oncreate: binder.oncreate,
            onremove: binder.onremove,
          }),
        ]),

        m("div", { style: card }, [
          m("div", { style: label }, "Bound Values (via createWcBindable)"),
          m("pre", { style: "font-size: 14px; color: #2563eb" },
            JSON.stringify(binder.values, null, 2),
          ),
        ]),

        items.length > 0 && m("div", { style: card }, [
          m("div", { style: label }, "Mithril-rendered item list (from bound state)"),
          m("ul", items.map((item) => m("li", item))),
        ]),

        m("details", { style: card }, [
          m("summary", { style: label + "; cursor: pointer" }, "Source Code"),
          m("pre", {
            style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px",
          }, m("code", appSource)),
        ]),
      ]);
    },
  };
};
