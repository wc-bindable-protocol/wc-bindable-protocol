import Alpine from "alpinejs";
import wcBindable from "../../packages/alpine/src/index.ts";
import "../vanilla/fetch/my-fetch.js";
// @ts-expect-error vite raw import
import appSource from "./app.html?raw";

Alpine.plugin(wcBindable);

document.getElementById("app")!.innerHTML = `
  <div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px"
    x-data="{
      url: 'https://jsonplaceholder.typicode.com/posts/1',
      value: null,
      loading: false,
      error: null,
      status: null,
      handleFetch() {
        const el = this.$refs.fetcher;
        el.url = this.url;
        el.fetch();
      },
      handleAbort() {
        this.$refs.fetcher.abort();
      }
    }">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Alpine — Fetch</h1>

    <my-fetch x-ref="fetcher" x-wc-bindable manual></my-fetch>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Request</div>
      <div style="display: flex; gap: 8px; align-items: center">
        <input
          type="text"
          x-model="url"
          style="flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px"
        />
        <button @click="handleFetch()" :disabled="loading"
          style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
          Fetch
        </button>
        <button @click="handleAbort()"
          style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
          Abort
        </button>
      </div>
    </div>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Bound State (via x-wc-bindable)</div>
      <div style="display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px">
        <span :style="'padding: 2px 8px; border-radius: 4px; background: ' + (loading ? '#fef3c7' : '#d1fae5') + '; color: ' + (loading ? '#92400e' : '#065f46')">
          loading: <strong x-text="loading ?? false"></strong>
        </span>
        <span>status: <strong x-text="status ?? '—'"></strong></span>
      </div>
      <template x-if="error">
        <div style="background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px"
          x-text="JSON.stringify(error, null, 2)"></div>
      </template>
      <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word"
        x-text="value ? JSON.stringify(value, null, 2) : '— No response yet —'"></pre>
    </div>

    <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code id="source-code"></code></pre>
    </details>
  </div>
`;

document.getElementById("source-code")!.textContent = appSource;

Alpine.start();
