import { h } from "preact";
import { useRef, useState, useCallback } from "preact/hooks";
import { useWcBindable } from "../../packages/preact/src/index.ts";
import type { MyFetchElement, MyFetchValues } from "../vanilla/fetch/types.ts";
import "../vanilla/fetch/my-fetch.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const section = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function App() {
  const [url, setUrl] = useState("https://jsonplaceholder.typicode.com/posts/1");
  const [bindRef, values] = useWcBindable<MyFetchElement, MyFetchValues>();
  const elRef = useRef<MyFetchElement | null>(null);

  const ref = useCallback((node: MyFetchElement | null) => {
    elRef.current = node;
    bindRef(node);
  }, [bindRef]);

  const handleFetch = useCallback(() => {
    const el = elRef.current;
    if (el) { el.url = url; el.fetch(); }
  }, [url]);

  const handleAbort = useCallback(() => { elRef.current?.abort(); }, []);

  return h("div", { style: "font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px" },
    h("p", null, h("a", { href: "/index.html" }, "\u2190 Examples")),
    h("h1", null, "wc-bindable: Preact \u2014 Fetch"),

    h("my-fetch", { ref, manual: true } as Record<string, unknown>),

    h("div", { style: section },
      h("div", { style: label }, "Request"),
      h("div", { style: "display: flex; gap: 8px; align-items: center" },
        h("input", {
          type: "text", value: url,
          onInput: (e: Event) => setUrl((e.target as HTMLInputElement).value),
          style: "flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px",
        }),
        h("button", {
          onClick: handleFetch, disabled: !!values.loading,
          style: "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer",
        }, "Fetch"),
        h("button", {
          onClick: handleAbort,
          style: "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer",
        }, "Abort"),
      ),
    ),

    h("div", { style: section },
      h("div", { style: label }, "Bound State (via useWcBindable)"),
      h("div", { style: "display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px" },
        h("span", {
          style: `padding: 2px 8px; border-radius: 4px; background: ${values.loading ? "#fef3c7" : "#d1fae5"}; color: ${values.loading ? "#92400e" : "#065f46"}`,
        }, "loading: ", h("strong", null, String(values.loading ?? false))),
        h("span", null, "status: ", h("strong", null, String(values.status ?? "\u2014"))),
      ),
      values.error
        ? h("div", { style: "background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px" },
            JSON.stringify(values.error, null, 2))
        : null,
      h("pre", { style: "background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word" },
        values.value ? JSON.stringify(values.value, null, 2) : "\u2014 No response yet \u2014",
      ),
    ),

    h("details", { style: section },
      h("summary", { style: label + "; cursor: pointer" }, "Source Code"),
      h("pre", { style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px" },
        h("code", null, appSource),
      ),
    ),
  );
}
