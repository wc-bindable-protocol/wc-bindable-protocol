<script lang="ts">
import { wcBindable } from "../../packages/svelte/src/index.ts";
import "../vanilla/fetch/my-fetch.js";
import appSource from "./App.svelte?raw";

let values = $state<Record<string, unknown>>({});
let url = $state("https://jsonplaceholder.typicode.com/posts/1");
let fetchEl: HTMLElement | undefined = $state();

function onUpdate(name: string, value: unknown) {
  values = { ...values, [name]: value };
}

function handleFetch() {
  const el = fetchEl as any;
  if (el) { el.url = url; el.fetch(); }
}

function handleAbort() {
  (fetchEl as any)?.abort();
}
</script>

<div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px">
  <p><a href="/index.html">&larr; Examples</a></p>
  <h1>wc-bindable: Svelte — Fetch</h1>

  <my-fetch bind:this={fetchEl} use:wcBindable={{ onUpdate }} manual></my-fetch>

  <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
    <div style="font-weight: 600; margin-bottom: 8px">Request</div>
    <div style="display: flex; gap: 8px; align-items: center">
      <input
        type="text"
        bind:value={url}
        style="flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px"
      />
      <button onclick={handleFetch} disabled={!!values.loading}
        style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
        Fetch
      </button>
      <button onclick={handleAbort}
        style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
        Abort
      </button>
    </div>
  </div>

  <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
    <div style="font-weight: 600; margin-bottom: 8px">Bound State (via wcBindable action)</div>
    <div style="display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px">
      <span style="padding: 2px 8px; border-radius: 4px; background: {values.loading ? '#fef3c7' : '#d1fae5'}; color: {values.loading ? '#92400e' : '#065f46'}">
        loading: <strong>{String(values.loading ?? false)}</strong>
      </span>
      <span>status: <strong>{String(values.status ?? '—')}</strong></span>
    </div>
    {#if values.error}
      <div style="background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px">
        {JSON.stringify(values.error, null, 2)}
      </div>
    {/if}
    <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word">{values.value ? JSON.stringify(values.value, null, 2) : '— No response yet —'}</pre>
  </div>

  <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
    <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
    <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>{appSource}</code></pre>
  </details>
</div>
