import van from "vanjs-core";
import { createWcBindable } from "@wc-bindable/vanjs";
import type { MyCounterValues } from "../../vanilla/counter/types.ts";
import "../../vanilla/counter/my-counter.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const { a, code, details, div, h1, p, pre, summary } = van.tags;

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export const App = () => {
  const binder = createWcBindable<MyCounterValues>({ count: 0 });

  const myCounter = document.createElement("my-counter");
  // Defer until after van.add() inserts the element, so connectedCallback()
  // has run and bind()'s initial sync reads post-connect property values.
  queueMicrotask(() => binder.bind(myCounter));

  return div(
    { style: "font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px" },
    p(a({ href: "/index.html" }, "← Examples")),
    h1("wc-bindable: VanJS — Counter"),

    div({ style: card },
      div({ style: label }, "Counter Component"),
      myCounter,
    ),

    div({ style: card },
      div({ style: label }, "Bound Values (via createWcBindable)"),
      pre(
        { style: "font-size: 14px; color: #2563eb" },
        () => JSON.stringify({ count: binder.states.count.val }, null, 2),
      ),
    ),

    details({ style: card },
      summary({ style: label + "; cursor: pointer" }, "Source Code"),
      pre(
        { style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px" },
        code(appSource),
      ),
    ),
  );
};
