<script setup lang="ts">
import { ref as vueRef } from "vue";
import { useWcBindable } from "../../packages/vue/src/index.ts";
import type { MyFetchElement, MyFetchValues } from "../vanilla/fetch/types.ts";
import "../vanilla/fetch/my-fetch.js";
import appSource from "./App.vue?raw";

const url = vueRef("https://jsonplaceholder.typicode.com/posts/1");
const { ref: fetcherRef, values } = useWcBindable<MyFetchElement, MyFetchValues>();

function handleFetch() {
  const el = fetcherRef.value;
  if (el) {
    el.url = url.value;
    el.fetch();
  }
}

function handleAbort() {
  fetcherRef.value?.abort();
}
</script>

<template>
  <div style="font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px">
    <p><a href="/index.html">&larr; Examples</a></p>
    <h1>wc-bindable: Vue — Fetch</h1>

    <my-fetch ref="fetcherRef" manual />

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Request</div>
      <div style="display: flex; gap: 8px; align-items: center">
        <input
          v-model="url"
          type="text"
          style="flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px"
        />
        <button @click="handleFetch" :disabled="!!values.loading"
          style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
          Fetch
        </button>
        <button @click="handleAbort"
          style="padding: 6px 16px; border: 1px solid #ccc; border-radius: 4px; background: #f5f5f5; cursor: pointer">
          Abort
        </button>
      </div>
    </div>

    <div style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <div style="font-weight: 600; margin-bottom: 8px">Bound State (via useWcBindable)</div>
      <div style="display: flex; gap: 16px; font-size: 14px; margin-bottom: 8px">
        <span :style="{
          padding: '2px 8px', borderRadius: '4px',
          background: values.loading ? '#fef3c7' : '#d1fae5',
          color: values.loading ? '#92400e' : '#065f46',
        }">
          loading: <strong>{{ values.loading ?? false }}</strong>
        </span>
        <span>status: <strong>{{ values.status ?? '—' }}</strong></span>
      </div>
      <div v-if="values.error"
        style="background: #fee2e2; color: #991b1b; padding: 8px; border-radius: 4px; margin-bottom: 8px">
        {{ JSON.stringify(values.error, null, 2) }}
      </div>
      <pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; max-height: 300px; overflow: auto; font-size: 13px; white-space: pre-wrap; word-break: break-word">{{
        values.value ? JSON.stringify(values.value, null, 2) : '— No response yet —'
      }}</pre>
    </div>

    <details style="margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px">
      <summary style="font-weight: 600; margin-bottom: 8px; cursor: pointer">Source Code</summary>
      <pre style="font-size: 13px; overflow: auto; margin: 8px 0 0; padding: 12px; background: #f8fafc; border-radius: 4px"><code>{{ appSource }}</code></pre>
    </details>
  </div>
</template>
