import { Signal } from "signal-polyfill";
import { createWcBindable } from "@wc-bindable/signals";
import type { MyFetchElement, MyFetchValues } from "../../vanilla/fetch/types.ts";
import "../../vanilla/fetch/my-fetch.js";
import { effect } from "../effect.ts";
// @ts-expect-error vite raw import
import appSource from "./App.ts?raw";

const section = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

export function mount(root: HTMLElement) {
  const binder = createWcBindable<MyFetchValues>({
    value: null,
    loading: false,
    error: null,
    status: 0,
  });
  const url = new Signal.State("https://jsonplaceholder.typicode.com/posts/1");

  const fetchEl = document.createElement("my-fetch") as MyFetchElement;
  fetchEl.setAttribute("manual", "");

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.value = url.get();
  urlInput.style.cssText = "flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px";
  urlInput.addEventListener("input", () => url.set(urlInput.value));

  const fetchBtn = document.createElement("button");
  fetchBtn.textContent = "Fetch";
  fetchBtn.style.cssText = "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer";
  fetchBtn.addEventListener("click", () => {
    fetchEl.url = url.get();
    fetchEl.fetch();
  });

  const abortBtn = document.createElement("button");
  abortBtn.textContent = "Abort";
  abortBtn.style.cssText = "padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer";
  abortBtn.addEventListener("click", () => fetchEl.abort());

  const requestRow = document.createElement("div");
  requestRow.style.cssText = "display: flex; gap: 8px; align-items: center";
  requestRow.append(urlInput, fetchBtn, abortBtn);

  const loadingPill = document.createElement("span");
  const loadingStrong = document.createElement("strong");
  loadingPill.append("loading: ", loadingStrong);

  const statusSpan = document.createElement("span");
  const statusStrong = document.createElement("strong");
  statusSpan.append("status: ", statusStrong);

  const statusRow = document.createElement("div");
  statusRow.style.cssText = "display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px";
  statusRow.append(loadingPill, statusSpan);

  const errorBox = document.createElement("div");
  errorBox.style.cssText = "background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px; display: none";

  const bodyPre = document.createElement("pre");
  bodyPre.style.cssText = "background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word";

  const sourcePre = document.createElement("pre");
  sourcePre.style.cssText = "font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px";
  const sourceCode = document.createElement("code");
  sourceCode.textContent = appSource;
  sourcePre.appendChild(sourceCode);

  root.innerHTML = `
    <div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px">
      <p><a href="/index.html">← Examples</a></p>
      <h1>wc-bindable: Signals — Fetch</h1>
      <div id="fetch-slot"></div>
      <div style="${section}">
        <div style="${label}">Request</div>
        <div id="request-slot"></div>
      </div>
      <div style="${section}">
        <div style="${label}">Bound State (via createWcBindable)</div>
        <div id="status-slot"></div>
        <div id="error-slot"></div>
        <div id="body-slot"></div>
      </div>
      <details style="${section}">
        <summary style="${label}; cursor: pointer">Source Code</summary>
        <div id="source-slot"></div>
      </details>
    </div>
  `;

  root.querySelector("#fetch-slot")!.appendChild(fetchEl);
  root.querySelector("#request-slot")!.appendChild(requestRow);
  root.querySelector("#status-slot")!.appendChild(statusRow);
  root.querySelector("#error-slot")!.appendChild(errorBox);
  root.querySelector("#body-slot")!.appendChild(bodyPre);
  root.querySelector("#source-slot")!.appendChild(sourcePre);

  // Bind AFTER <my-fetch> is connected so its connectedCallback() and any
  // post-connect property initialization are visible to the initial sync.
  binder.bind(fetchEl);

  effect(() => {
    const loading = !!binder.signals.loading.get();
    loadingPill.style.cssText = `padding: 2px 8px; border-radius: 4px; background: ${loading ? "#fef3c7" : "#d1fae5"}; color: ${loading ? "#92400e" : "#065f46"}`;
    loadingStrong.textContent = String(loading);
    fetchBtn.disabled = loading;
  });

  effect(() => {
    statusStrong.textContent = String(binder.signals.status.get() || "—");
  });

  effect(() => {
    const err = binder.signals.error.get();
    if (err) {
      errorBox.style.display = "";
      errorBox.textContent = JSON.stringify(err, null, 2);
    } else {
      errorBox.style.display = "none";
      errorBox.textContent = "";
    }
  });

  effect(() => {
    const v = binder.signals.value.get();
    bodyPre.textContent = v ? JSON.stringify(v, null, 2) : "— No response yet —";
  });
}
