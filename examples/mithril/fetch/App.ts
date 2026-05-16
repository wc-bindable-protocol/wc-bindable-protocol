import m from "mithril";
import { createWcBindable } from "@wc-bindable/mithril";
import type { MyFetchElement, MyFetchValues } from "../../vanilla/fetch/types.ts";
import "../../vanilla/fetch/my-fetch.js";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const section = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export const App = () => {
  const binder = createWcBindable<MyFetchValues>({
    value: null,
    loading: false,
    error: null,
    status: 0,
  });
  let url = "https://jsonplaceholder.typicode.com/posts/1";
  let fetchEl: MyFetchElement | null = null;

  const onFetch = () => {
    if (!fetchEl) return;
    fetchEl.url = url;
    fetchEl.fetch();
  };

  const onAbort = () => {
    fetchEl?.abort();
  };

  return {
    view: () => {
      const v = binder.values;
      const loading = !!v.loading;
      return m("div", { style: "font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px" }, [
        m("p", m("a", { href: "/index.html" }, "← Examples")),
        m("h1", "wc-bindable: Mithril — Fetch"),

        m("my-fetch", {
          manual: true,
          oncreate: (vnode: m.VnodeDOM) => {
            fetchEl = vnode.dom as MyFetchElement;
            binder.oncreate(vnode);
          },
          onremove: () => {
            binder.onremove();
            fetchEl = null;
          },
        }),

        m("div", { style: section }, [
          m("div", { style: label }, "Request"),
          m("div", { style: "display: flex; gap: 8px; align-items: center" }, [
            m("input", {
              type: "text",
              value: url,
              oninput: (e: Event) => { url = (e.target as HTMLInputElement).value; },
              style: "flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px",
            }),
            m("button", {
              onclick: onFetch,
              disabled: loading,
              style: "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer",
            }, "Fetch"),
            m("button", {
              onclick: onAbort,
              style: "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer",
            }, "Abort"),
          ]),
        ]),

        m("div", { style: section }, [
          m("div", { style: label }, "Bound State (via createWcBindable)"),
          m("div", { style: "display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px" }, [
            m("span", {
              style: `padding: 2px 8px; border-radius: 4px; background: ${loading ? "#fef3c7" : "#d1fae5"}; color: ${loading ? "#92400e" : "#065f46"}`,
            }, ["loading: ", m("strong", String(loading))]),
            m("span", ["status: ", m("strong", String(v.status || "—"))]),
          ]),
          v.error && m("div", {
            style: "background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px",
          }, JSON.stringify(v.error, null, 2)),
          m("pre", {
            style: "background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word",
          }, v.value ? JSON.stringify(v.value, null, 2) : "— No response yet —"),
        ]),

        m("details", { style: section }, [
          m("summary", { style: label + "; cursor: pointer" }, "Source Code"),
          m("pre", {
            style: "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px",
          }, m("code", appSource)),
        ]),
      ]);
    },
  };
};
