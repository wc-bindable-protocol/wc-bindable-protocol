import { h } from "preact";
import { useWcBindable } from "../../packages/preact/src/index.ts";
import type { MyCounterElement, MyCounterValues } from "../vanilla/counter/types.ts";
import "../vanilla/counter/my-counter.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function App() {
  const [ref, values] = useWcBindable<MyCounterElement, MyCounterValues>();

  return h("div", { style: "font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px" },
    h("p", null, h("a", { href: "/index.html" }, "\u2190 Examples")),
    h("h1", null, "wc-bindable: Preact \u2014 Counter"),

    h("div", { style: card },
      h("div", { style: label }, "Counter Component"),
      h("my-counter", { ref } as Record<string, unknown>),
    ),

    h("div", { style: card },
      h("div", { style: label }, "Bound Values (via useWcBindable)"),
      h("pre", { style: "font-size: 14px; color: #2563eb" },
        JSON.stringify(values, null, 2),
      ),
    ),

    h("details", { style: card },
      h("summary", { style: label + "; cursor: pointer" }, "Source Code"),
      h("pre", { style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px" },
        h("code", null, appSource),
      ),
    ),
  );
}
