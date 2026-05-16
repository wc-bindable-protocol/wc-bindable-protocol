import m from "mithril";
import { createWcBindable } from "@wc-bindable/mithril";
import type { MyCounterValues } from "../../vanilla/counter/types.ts";
import "../../vanilla/counter/my-counter.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export const App = () => {
  const binder = createWcBindable<MyCounterValues>();

  return {
    view: () =>
      m("div", { style: "font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px" }, [
        m("p", m("a", { href: "/index.html" }, "← Examples")),
        m("h1", "wc-bindable: Mithril — Counter"),

        m("div", { style: card }, [
          m("div", { style: label }, "Counter Component"),
          m("my-counter", {
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

        m("details", { style: card }, [
          m("summary", { style: label + "; cursor: pointer" }, "Source Code"),
          m("pre", { style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px" },
            m("code", appSource),
          ),
        ]),
      ]),
  };
};
