import { bind, isWcBindable } from "../../packages/core/src/index.ts";
import "../vanilla/fetch/my-fetch.js";

const card = "margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px";
const label = "font-weight: 600; margin-bottom: 8px";

document.getElementById("app")!.innerHTML = `
  <div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Angular — Fetch</h1>
    <p style="color: #6b7280; font-size: 14px">
      Angular requires its own compiler/build pipeline and cannot run inside Vite directly.
      Below is the directive source and a plain-JS demo using the same <code>bind()</code> core that the directive wraps.
    </p>

    <my-fetch id="fetcher" manual></my-fetch>

    <div style="${card}">
      <div style="${label}">Request</div>
      <div style="display: flex; gap: 8px; align-items: center">
        <input
          id="url-input"
          type="text"
          value="https://jsonplaceholder.typicode.com/posts/1"
          style="flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px"
        />
        <button id="btn-fetch"
          style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
          Fetch
        </button>
        <button id="btn-abort"
          style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
          Abort
        </button>
      </div>
    </div>

    <div style="${card}">
      <div style="${label}">Bound State (via bind)</div>
      <div style="display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px">
        <span id="loading-badge" style="padding: 2px 8px; border-radius: 4px; background: #d1fae5; color: #065f46">
          loading: <strong id="loading-text">false</strong>
        </span>
        <span>status: <strong id="status-text">—</strong></span>
      </div>
      <div id="error-box" style="background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px; display: none"></div>
      <pre id="response" style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word">— No response yet —</pre>
    </div>

    <details style="${card}">
      <summary style="${label}; cursor: pointer">Angular Directive Source</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code id="source-code"></code></pre>
    </details>
  </div>
`;

const fetcher = document.getElementById("fetcher") as any;
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const loadingBadge = document.getElementById("loading-badge")!;
const loadingText = document.getElementById("loading-text")!;
const statusText = document.getElementById("status-text")!;
const errorBox = document.getElementById("error-box")!;
const response = document.getElementById("response")!;
const btnFetch = document.getElementById("btn-fetch") as HTMLButtonElement;

if (isWcBindable(fetcher)) {
  bind(fetcher, (name, value) => {
    if (name === "loading") {
      loadingText.textContent = String(value ?? false);
      loadingBadge.style.background = value ? "#fef3c7" : "#d1fae5";
      loadingBadge.style.color = value ? "#92400e" : "#065f46";
      btnFetch.disabled = !!value;
    } else if (name === "status") {
      statusText.textContent = String(value ?? "\u2014");
    } else if (name === "error") {
      if (value) {
        errorBox.textContent = JSON.stringify(value, null, 2);
        errorBox.style.display = "";
      } else {
        errorBox.style.display = "none";
      }
    } else if (name === "value") {
      response.textContent = value ? JSON.stringify(value, null, 2) : "\u2014 No response yet \u2014";
    }
  });
}

document.getElementById("btn-fetch")!.addEventListener("click", () => {
  fetcher.url = urlInput.value;
  fetcher.fetch();
});

document.getElementById("btn-abort")!.addEventListener("click", () => {
  fetcher.abort();
});

import("../../packages/angular/src/index.ts?raw").then((mod) => {
  document.getElementById("source-code")!.textContent = mod.default;
});
