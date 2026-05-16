import van from "vanjs-core";
import { createWcBindable } from "@wc-bindable/vanjs";
import type { MyFetchElement, MyFetchValues } from "../../vanilla/fetch/types.ts";
import "../../vanilla/fetch/my-fetch.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const { a, button, code, details, div, h1, input, p, pre, span, strong, summary } = van.tags;

const section = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export const App = () => {
  const binder = createWcBindable<MyFetchValues>({
    value: null,
    loading: false,
    error: null,
    status: 0,
  });
  const url = van.state("https://jsonplaceholder.typicode.com/posts/1");

  const fetchEl = document.createElement("my-fetch") as MyFetchElement;
  fetchEl.setAttribute("manual", "");
  // Defer until after van.add() inserts the element, so connectedCallback()
  // has run and bind()'s initial sync reads post-connect property values.
  queueMicrotask(() => binder.bind(fetchEl));

  const onFetch = () => {
    fetchEl.url = url.val;
    fetchEl.fetch();
  };

  const onAbort = () => fetchEl.abort();

  return div(
    { style: "font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px" },
    p(a({ href: "/index.html" }, "← Examples")),
    h1("wc-bindable: VanJS — Fetch"),

    fetchEl,

    div({ style: section },
      div({ style: label }, "Request"),
      div({ style: "display: flex; gap: 8px; align-items: center" },
        input({
          type: "text",
          value: url,
          oninput: (e: Event) => { url.val = (e.target as HTMLInputElement).value; },
          style: "flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px",
        }),
        button({
          onclick: onFetch,
          disabled: () => !!binder.states.loading.val,
          style: "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer",
        }, "Fetch"),
        button({
          onclick: onAbort,
          style: "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer",
        }, "Abort"),
      ),
    ),

    div({ style: section },
      div({ style: label }, "Bound State (via createWcBindable)"),
      div({ style: "display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px" },
        span(
          {
            style: () => {
              const loading = !!binder.states.loading.val;
              return `padding: 2px 8px; border-radius: 4px; background: ${loading ? "#fef3c7" : "#d1fae5"}; color: ${loading ? "#92400e" : "#065f46"}`;
            },
          },
          "loading: ",
          strong(() => String(!!binder.states.loading.val)),
        ),
        span("status: ", strong(() => String(binder.states.status.val || "—"))),
      ),
      () => {
        const err = binder.states.error.val;
        return err
          ? div(
              { style: "background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px" },
              JSON.stringify(err, null, 2),
            )
          : div({ style: "display: none" });
      },
      pre(
        { style: "background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word" },
        () => {
          const v = binder.states.value.val;
          return v ? JSON.stringify(v, null, 2) : "— No response yet —";
        },
      ),
    ),

    details({ style: section },
      summary({ style: label + "; cursor: pointer" }, "Source Code"),
      pre(
        { style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px" },
        code(appSource),
      ),
    ),
  );
};
