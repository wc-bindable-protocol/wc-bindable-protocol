<script lang="ts">
import { wcBindable } from "../../packages/svelte/src/index.ts";
import "../vanilla/lit-todo/lit-todo.ts";
import appSource from "./App.svelte?raw";

let values = $state<Record<string, unknown>>({});

function onUpdate(name: string, value: unknown) {
  values = { ...values, [name]: value };
}
</script>

<div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px">
  <p><a href="/index.html">&larr; Examples</a></p>
  <h1>wc-bindable: Svelte — Lit Todo</h1>

  <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
    <div style="font-weight: 600; margin-bottom: 8px">
      Lit Todo Component
      {#if values.count != null}
        <span style="display: inline-block; background: #2563eb; color: white; border-radius: 12px; padding: 2px 10px; font-size: 13px; margin-left: 8px">
          {values.count}
        </span>
      {/if}
    </div>
    <lit-todo use:wcBindable={{ onUpdate }}></lit-todo>
  </div>

  <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
    <div style="font-weight: 600; margin-bottom: 8px">Bound Values (via wcBindable action)</div>
    <pre style="font-size: 14px; color: #2563eb">{JSON.stringify(values, null, 2)}</pre>
  </div>

  {#if values.items && (values.items as string[]).length > 0}
    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Svelte-rendered item list (from bound state)</div>
      <ul>
        {#each values.items as item, i (i)}
          <li>{item}</li>
        {/each}
      </ul>
    </div>
  {/if}

  <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
    <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
    <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>{appSource}</code></pre>
  </details>
</div>
